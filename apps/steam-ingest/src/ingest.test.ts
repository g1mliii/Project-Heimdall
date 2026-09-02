import { describe, expect, it, vi } from "vitest";

import type { SqlExecutor } from "./db";
import { errorSummary, runLane } from "./ingest";
import type { IngestLogger } from "./types";

interface Recorded {
  text: string;
  params: readonly unknown[];
}

/**
 * Stands in for Neon: answers the two read statements from `trackedApps` and
 * records every write so a test can assert on the rows that would land.
 */
function stubDb(trackedApps: number[]) {
  const calls: Recorded[] = [];
  const execute = vi.fn(async (text: string, params: readonly unknown[]) => {
    calls.push({ text, params });
    if (text.includes("from steam_apps") && text.trimStart().startsWith("select")) {
      const limit = typeof params[0] === "number" ? params[0] : trackedApps.length;
      return trackedApps.slice(0, limit).map((appid) => ({ appid: String(appid) }));
    }
    const batch = JSON.parse(String(params[0]));
    // The metadata statement is a CTE returning one report row, not one row
    // per input; everything else returns one row per row written.
    if (text.includes("steam_app_changes")) {
      return [{ upserted: batch.length, changes: 0 }];
    }
    return batch.map(() => ({ ok: 1 }));
  }) as unknown as SqlExecutor;

  const written = (table: string) =>
    calls
      .filter((call) => call.text.includes(table) && call.text.trimStart().startsWith("insert"))
      .flatMap((call) => JSON.parse(String(call.params[0])) as Record<string, unknown>[]);

  return { calls, execute, written };
}

const silentLogger: IngestLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

/** Routes a stub fetch by URL substring; an unrouted URL is a test bug. */
function routedFetch(routes: Record<string, unknown | (() => never)>) {
  return vi.fn(async (input: URL | RequestInfo) => {
    const url = String(input);
    for (const [needle, body] of Object.entries(routes)) {
      if (!url.includes(needle)) continue;
      if (typeof body === "function") (body as () => never)();
      return new Response(JSON.stringify(body), { status: 200 });
    }
    throw new Error(`unrouted fetch: ${url}`);
  }) as unknown as typeof fetch;
}

const now = new Date("2026-09-02T16:07:41.512Z");

describe("players lane", () => {
  it("writes one row per reporting app, on a single floored bucket", async () => {
    const db = stubDb([730, 570]);
    const fetchImpl = routedFetch({
      "appid=730": { response: { result: 1, player_count: 844861 } },
      "appid=570": { response: { result: 1, player_count: 512000 } },
    });
    const report = await runLane("players", {
      execute: db.execute,
      fetchImpl,
      logger: silentLogger,
      now,
    });
    expect(report).toEqual({ lane: "players", appsPolled: 2, rowsWritten: 2, appsFailed: 0 });
    expect(db.written("steam_player_counts")).toEqual([
      { appid: 730, bucket: "2026-09-02T16:00:00.000Z", players: 844861 },
      { appid: 570, bucket: "2026-09-02T16:00:00.000Z", players: 512000 },
    ]);
  });

  it("does not count a non-reporting app as a failure", async () => {
    const db = stubDb([730, 12345]);
    const fetchImpl = routedFetch({
      "appid=730": { response: { result: 1, player_count: 10 } },
      "appid=12345": { response: { result: 42 } },
    });
    const report = await runLane("players", {
      execute: db.execute,
      fetchImpl,
      logger: silentLogger,
      now,
    });
    expect(report).toMatchObject({ appsPolled: 2, rowsWritten: 1, appsFailed: 0 });
  });

  it("keeps the good samples when one app's request throws", async () => {
    const db = stubDb([730, 999]);
    const fetchImpl = routedFetch({
      "appid=730": { response: { result: 1, player_count: 10 } },
      "appid=999": () => {
        throw new Error("upstream 429");
      },
    });
    const report = await runLane("players", {
      execute: db.execute,
      fetchImpl,
      logger: silentLogger,
      now,
    });
    expect(report).toMatchObject({ rowsWritten: 1, appsFailed: 1 });
    expect(db.written("steam_player_counts")).toHaveLength(1);
  });

  it("honours the per-invocation app cap", async () => {
    const db = stubDb([1, 2, 3, 4, 5]);
    const fetchImpl = routedFetch({
      "GetNumberOfCurrentPlayers": { response: { result: 1, player_count: 1 } },
    });
    const report = await runLane("players", {
      execute: db.execute,
      fetchImpl,
      logger: silentLogger,
      now,
      limits: { playerApps: 2 },
    });
    expect(report.appsPolled).toBe(2);
  });

  it("re-running inside one cadence window rewrites the same bucket key", async () => {
    const fetchImpl = routedFetch({
      "GetNumberOfCurrentPlayers": { response: { result: 1, player_count: 5 } },
    });
    const first = stubDb([730]);
    const second = stubDb([730]);
    await runLane("players", { execute: first.execute, fetchImpl, logger: silentLogger, now });
    await runLane("players", {
      execute: second.execute,
      fetchImpl,
      logger: silentLogger,
      now: new Date("2026-09-02T16:09:59.999Z"),
    });
    expect(first.written("steam_player_counts")[0]!.bucket).toBe(
      second.written("steam_player_counts")[0]!.bucket,
    );
  });
});

describe("prices lane", () => {
  it("covers the working set in batched subrequests", async () => {
    const db = stubDb([730, 1091500]);
    const fetchImpl = routedFetch({
      appdetails: {
        "730": { success: true, data: [] },
        "1091500": {
          success: true,
          data: { price_overview: { currency: "USD", initial: 5999, final: 5999, discount_percent: 0 } },
        },
      },
    });
    const report = await runLane("prices", {
      execute: db.execute,
      fetchImpl,
      logger: silentLogger,
      now,
    });
    expect(report).toMatchObject({ lane: "prices", appsPolled: 2, rowsWritten: 1, appsFailed: 0 });
    // One request covered both apps.
    expect(vi.mocked(fetchImpl)).toHaveBeenCalledTimes(1);
    expect(db.written("steam_price_snapshots")[0]).toMatchObject({
      appid: 1091500,
      country_code: "us",
      bucket: "2026-09-02T12:00:00.000Z",
    });
  });

  it("reports lost coverage in apps, not requests, when a batch fails", async () => {
    const db = stubDb([730, 1091500]);
    const fetchImpl = routedFetch({
      appdetails: () => {
        throw new Error("upstream 500");
      },
    });
    const report = await runLane("prices", {
      execute: db.execute,
      fetchImpl,
      logger: silentLogger,
      now,
    });
    expect(report).toMatchObject({ rowsWritten: 0, appsFailed: 2 });
  });
});

describe("catalog lane", () => {
  const metadata = {
    "730": {
      success: true,
      data: {
        type: "game",
        name: "Counter-Strike 2",
        is_free: true,
        release_date: { coming_soon: false, date: "Aug 21, 2012" },
        developers: ["Valve"],
        publishers: ["Valve"],
      },
    },
  };
  const news = {
    appnews: {
      newsitems: [
        { gid: "g1", title: "CS2 Update", date: 1_787_614_760, tags: ["patchnotes"] },
      ],
    },
  };

  it("discovers, then refreshes the stalest slice", async () => {
    const db = stubDb([730]);
    const fetchImpl = routedFetch({
      featuredcategories: { top_sellers: { items: [{ id: 730, name: "Counter-Strike 2" }] } },
      appdetails: metadata,
      GetNewsForApp: news,
    });
    const report = await runLane("catalog", {
      execute: db.execute,
      fetchImpl,
      logger: silentLogger,
      now,
    });
    expect(report).toMatchObject({ lane: "catalog", appsPolled: 1, appsFailed: 0 });
    expect(db.written("steam_app_updates")[0]).toMatchObject({ gid: "g1", is_patchnote: true });
    const apps = db.calls.filter((call) => call.text.includes("insert into steam_apps"));
    expect(apps.length).toBeGreaterThanOrEqual(2); // discovery upsert + metadata upsert
  });

  it("still refreshes metadata when discovery fails", async () => {
    const db = stubDb([730]);
    const warn = vi.fn();
    const fetchImpl = routedFetch({
      featuredcategories: () => {
        throw new Error("upstream 503");
      },
      appdetails: metadata,
      GetNewsForApp: news,
    });
    const report = await runLane("catalog", {
      execute: db.execute,
      fetchImpl,
      logger: { ...silentLogger, warn },
      now,
    });
    expect(report.appsPolled).toBe(1);
    expect(report.rowsWritten).toBeGreaterThan(0);
    expect(warn).toHaveBeenCalledWith("steam featured discovery failed", expect.anything());
  });

  it("bounds its subrequests by the catalog cap", async () => {
    const db = stubDb([1, 2, 3, 4]);
    const fetchImpl = routedFetch({
      featuredcategories: {},
      appdetails: { "1": { success: false } },
      GetNewsForApp: { appnews: { newsitems: [] } },
    });
    const report = await runLane("catalog", {
      execute: db.execute,
      fetchImpl,
      logger: silentLogger,
      now,
      limits: { catalogApps: 2 },
    });
    expect(report.appsPolled).toBe(2);
  });
});

describe("errorSummary", () => {
  it("redacts a connection string that reached an error message", () => {
    const summary = errorSummary(
      new Error("connect failed for postgresql://user:pw@host.neon.tech/heimdall"),
    );
    expect(summary).toContain("[redacted database URL]");
    expect(summary).not.toContain("pw@");
  });

  it("never leaks a non-Error throw verbatim", () => {
    expect(errorSummary({ secret: "value" })).toBe("unknown ingest error");
  });
});
