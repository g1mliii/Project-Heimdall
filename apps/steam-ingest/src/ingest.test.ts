import { describe, expect, it, vi } from "vitest";

import type { SqlExecutor } from "./db";
import { errorSummary, pollWindow, runLane } from "./ingest";
import { LANE_CADENCE_MS } from "./sources";
import type { IngestLogger } from "./types";

interface Recorded {
  text: string;
  params: readonly unknown[];
}

/**
 * Stands in for Neon: answers the two read statements from `trackedApps` and
 * records every write so a test can assert on the rows that would land.
 */
function stubDb(trackedApps: number[], highCadence: readonly number[] = []) {
  const calls: Recorded[] = [];
  const execute = vi.fn(async (text: string, params: readonly unknown[]) => {
    calls.push({ text, params });
    if (text.trimStart().startsWith("update steam_apps")) return []; // demotion: nothing parked
    if (text.includes("update games g")) return []; // linker: nothing resolved
    if (text.includes("from steam_catalog_cursor")) return [];
    if (text.trimStart().startsWith("insert into steam_catalog_cursor")) return [];
    if (text.includes("jsonb_array_elements_text")) {
      // known-appid lookup: everything already tracked is "known".
      const asked = JSON.parse(String(params[0])) as number[];
      return asked.filter((a) => trackedApps.includes(a)).map((appid) => ({ appid: String(appid) }));
    }
    if (text.includes("from steam_apps") && text.trimStart().startsWith("select")) {
      const limit = typeof params[0] === "number" ? params[0] : trackedApps.length;
      return trackedApps
        .slice(0, limit)
        .map((appid) => ({ appid: String(appid), poll_tier: highCadence.includes(appid) ? 1 : 2 }));
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
    const db = stubDb([1, 2, 3, 4]);
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

  /** The appids one players run actually sampled, on a fresh stub each time. */
  const appidsPolledAt = async (
    at: Date,
    apps: number[],
    playerApps: number,
    highCadence: number[] = [],
  ) => {
    const db = stubDb(apps, highCadence);
    await runLane("players", {
      execute: db.execute,
      fetchImpl: routedFetch({
        GetNumberOfCurrentPlayers: { response: { result: 1, player_count: 1 } },
      }),
      logger: silentLogger,
      now: at,
      limits: { playerApps },
    });
    return db.written("steam_player_counts").map((row) => row.appid);
  };
  const nextRun = new Date(now.getTime() + LANE_CADENCE_MS.players);

  it("polls a different window of an oversized working set on the next run", async () => {
    // A cap with no rotation is a blind spot, not a budget: the tail of the
    // working set would never be sampled once.
    const first = await appidsPolledAt(now, [1, 2, 3, 4], 2);
    const second = await appidsPolledAt(nextRun, [1, 2, 3, 4], 2);
    expect(first).toHaveLength(2);
    expect(second).toHaveLength(2);
    expect(new Set([...first, ...second])).toEqual(new Set([1, 2, 3, 4]));
  });

  it("keeps the high-cadence tier in every run and rotates only the rest", async () => {
    // Rotating tier 1 too would silently erase the distinction poll_tier exists
    // to draw, which the old unrotated slice honoured only by accident of the
    // tier-ascending sort.
    const first = await appidsPolledAt(now, [1, 2, 3, 4, 5], 3, [1]);
    const second = await appidsPolledAt(nextRun, [1, 2, 3, 4, 5], 3, [1]);
    expect(first).toContain(1);
    expect(second).toContain(1);
    expect(new Set([...first, ...second])).toEqual(new Set([1, 2, 3, 4, 5]));
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

  it("caps the apps it prices, the one lane that used to price the whole set", async () => {
    const db = stubDb([730, 570, 440, 1091500]);
    const fetchImpl = routedFetch({ appdetails: {} });
    const report = await runLane("prices", {
      execute: db.execute,
      fetchImpl,
      logger: silentLogger,
      now,
      limits: { priceApps: 2 },
    });
    expect(report.appsPolled).toBe(2);
    expect(vi.mocked(fetchImpl)).toHaveBeenCalledTimes(1);
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
      ISteamChartsService: { response: { ranks: [{ rank: 1, appid: 730 }] } },
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
      ISteamChartsService: { response: { ranks: [] } },
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
      ISteamChartsService: { response: { ranks: [] } },
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

describe("charts discovery in the catalog lane", () => {
  it("resolves names only for appids it does not already track", async () => {
    const db = stubDb([730]); // 730 known; 570 and 999 are new
    const names: number[] = [];
    const fetchImpl = vi.fn(async (input: URL | RequestInfo) => {
      const url = String(input);
      if (url.includes("ISteamChartsService")) {
        return new Response(
          JSON.stringify({ response: { ranks: [{ appid: 730 }, { appid: 570 }, { appid: 999 }] } }),
          { status: 200 },
        );
      }
      if (url.includes("filters=basic")) {
        const appid = Number(new URL(url).searchParams.get("appids"));
        names.push(appid);
        return new Response(
          JSON.stringify({ [appid]: { success: true, data: { type: "game", name: `Game ${appid}` } } }),
          { status: 200 },
        );
      }
      if (url.includes("featuredcategories")) return new Response("{}", { status: 200 });
      if (url.includes("appdetails")) return new Response(JSON.stringify({ "730": { success: false } }), { status: 200 });
      return new Response(JSON.stringify({ appnews: { newsitems: [] } }), { status: 200 });
    }) as unknown as typeof fetch;

    const report = await runLane("catalog", { execute: db.execute, fetchImpl, logger: silentLogger, now });
    // 730 was already tracked, so no name lookup was paid for it.
    expect(names.sort()).toEqual([570, 999]);
    expect(report.appsDiscovered).toBeGreaterThan(0);
    const seeded = db.written("steam_apps").filter((r) => r.tracking_reason === "charts");
    expect(seeded.map((r) => r.appid).sort()).toEqual([570, 999]);
    expect(seeded.every((r) => r.poll_tier === 1)).toBe(true);
  });

  it("caps name lookups so one run cannot exhaust the subrequest budget", async () => {
    const db = stubDb([]);
    let lookups = 0;
    const fetchImpl = vi.fn(async (input: URL | RequestInfo) => {
      const url = String(input);
      if (url.includes("ISteamChartsService")) {
        return new Response(
          JSON.stringify({ response: { ranks: Array.from({ length: 50 }, (_, i) => ({ appid: 1000 + i })) } }),
          { status: 200 },
        );
      }
      if (url.includes("filters=basic")) {
        lookups++;
        const appid = Number(new URL(url).searchParams.get("appids"));
        return new Response(JSON.stringify({ [appid]: { success: true, data: { type: "game", name: "x" } } }), { status: 200 });
      }
      if (url.includes("featuredcategories")) return new Response("{}", { status: 200 });
      return new Response(JSON.stringify({ appnews: { newsitems: [] } }), { status: 200 });
    }) as unknown as typeof fetch;

    await runLane("catalog", {
      execute: db.execute,
      fetchImpl,
      logger: silentLogger,
      now,
      limits: { nameLookups: 5 },
    });
    expect(lookups).toBe(5);
  });

  it("still refreshes metadata when both discovery sources fail", async () => {
    const db = stubDb([730]);
    const warn = vi.fn();
    const fetchImpl = routedFetch({
      ISteamChartsService: () => {
        throw new Error("upstream 503");
      },
      featuredcategories: () => {
        throw new Error("upstream 503");
      },
      appdetails: { "730": { success: true, data: { type: "game", name: "Counter-Strike 2" } } },
      GetNewsForApp: { appnews: { newsitems: [] } },
    });
    const report = await runLane("catalog", {
      execute: db.execute,
      fetchImpl,
      logger: { ...silentLogger, warn },
      now,
    });
    expect(report.appsPolled).toBe(1);
    expect(report.appsDiscovered).toBe(0);
  });
});

describe("pollWindow", () => {
  const cadence = LANE_CADENCE_MS.players;
  const at = (steps: number) => new Date(now.getTime() + steps * cadence);
  /** Standard tier, so nothing is pinned unless a case says so. */
  const standard = (...appids: number[]) => appids.map((appid) => ({ appid, pollTier: 2 }));

  it("returns the whole working set when it fits under the cap", () => {
    expect(pollWindow(standard(1, 2, 3), 5, now, cadence)).toEqual([1, 2, 3]);
  });

  it("covers every app exactly once across one full rotation", () => {
    const apps = standard(1, 2, 3, 4, 5);
    const seen: number[] = [];
    for (let step = 0; step < 3; step++) {
      const window = pollWindow(apps, 2, at(step), cadence);
      expect(window.length).toBeLessThanOrEqual(2);
      seen.push(...window);
    }
    expect(seen.sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5]);
  });

  it("holds the same window for a retry inside one cadence bucket", () => {
    const apps = standard(1, 2, 3, 4, 5);
    const start = Math.floor(now.getTime() / cadence) * cadence;
    const first = pollWindow(apps, 2, new Date(start), cadence);
    const retry = pollWindow(apps, 2, new Date(start + cadence - 1), cadence);
    expect(retry).toEqual(first);
  });

  it("polls the high-cadence tier every run and never lets it exceed the cap", () => {
    const apps = [
      { appid: 10, pollTier: 1 },
      { appid: 11, pollTier: 1 },
      ...standard(1, 2, 3, 4, 5),
    ];
    for (let step = 0; step < 4; step++) {
      const window = pollWindow(apps, 3, at(step), cadence);
      expect(window).toHaveLength(3);
      expect(window.slice(0, 2)).toEqual([10, 11]);
    }
  });

  it("rotates the high-cadence tier itself once it alone overruns the cap", () => {
    const apps = [
      { appid: 10, pollTier: 1 },
      { appid: 11, pollTier: 1 },
      { appid: 12, pollTier: 1 },
      ...standard(1, 2),
    ];
    const seen = new Set<number>();
    for (let step = 0; step < 2; step++) {
      const window = pollWindow(apps, 2, at(step), cadence);
      expect(window.length).toBeLessThanOrEqual(2);
      window.forEach((appid) => seen.add(appid));
    }
    // The cap is the binding constraint, so the standard tier waits.
    expect(seen).toEqual(new Set([10, 11, 12]));
  });

  it("refuses a nonsensical cap rather than silently polling nothing", () => {
    expect(() => pollWindow(standard(1, 2), 0, now, cadence)).toThrow(/positive integer/);
  });
});

describe("bulk catalog seed (8.7.8)", () => {
  const catalogRoutes = {
    ISteamChartsService: { response: { ranks: [] } },
    featuredcategories: {},
    appdetails: { "730": { success: false } },
    GetNewsForApp: { appnews: { newsitems: [] } },
  };

  it("does nothing at all without a key, rather than failing the run", async () => {
    const db = stubDb([730]);
    const fetchImpl = routedFetch(catalogRoutes);
    const report = await runLane("catalog", {
      execute: db.execute,
      fetchImpl,
      logger: silentLogger,
      now,
    });
    expect(report.appsSeeded).toBe(0);
    expect(String(vi.mocked(fetchImpl).mock.calls)).not.toContain("GetAppList");
  });

  it("seeds a page at tier 0 so breadth costs the polled lanes nothing", async () => {
    const db = stubDb([730]);
    const fetchImpl = routedFetch({
      ...catalogRoutes,
      GetAppList: {
        response: {
          apps: [
            { appid: 111, name: "Seeded One" },
            { appid: 222, name: "Seeded Two" },
          ],
          last_appid: 222,
          have_more_results: false,
        },
      },
    });
    const report = await runLane("catalog", {
      execute: db.execute,
      fetchImpl,
      logger: silentLogger,
      now,
      steamApiKey: "test-key",
    });
    expect(report.appsSeeded).toBe(2);
    const seeded = db.calls.find((call) => call.text.includes("insert into steam_apps (appid, name, app_type, poll_tier"));
    expect(seeded).toBeDefined();
    expect(seeded!.text).toContain("'game', 0, 'catalog'");
    // `do nothing`: a bulk pass must never trample a tracked app's tier.
    expect(seeded!.text).toContain("on conflict (appid) do nothing");
  });

  it("stops paging when Steam says there is no more, and rewinds the cursor", async () => {
    const db = stubDb([730]);
    let pages = 0;
    const fetchImpl = vi.fn(async (input: URL | RequestInfo) => {
      const url = String(input);
      if (url.includes("GetAppList")) {
        pages++;
        return new Response(
          JSON.stringify({
            response: { apps: [{ appid: 900 + pages, name: `App ${pages}` }], last_appid: 900 + pages, have_more_results: pages < 2 },
          }),
          { status: 200 },
        );
      }
      if (url.includes("ISteamChartsService")) return new Response(JSON.stringify({ response: { ranks: [] } }), { status: 200 });
      if (url.includes("featuredcategories")) return new Response("{}", { status: 200 });
      if (url.includes("appdetails")) return new Response(JSON.stringify({ "730": { success: false } }), { status: 200 });
      return new Response(JSON.stringify({ appnews: { newsitems: [] } }), { status: 200 });
    }) as unknown as typeof fetch;

    await runLane("catalog", {
      execute: db.execute,
      fetchImpl,
      logger: silentLogger,
      now,
      steamApiKey: "test-key",
      limits: { catalogSeedPages: 5 },
    });
    // Two pages, then have_more_results false ends the sweep early.
    expect(pages).toBe(2);
    const cursorWrites = db.calls.filter((call) =>
      call.text.trimStart().startsWith("insert into steam_catalog_cursor"),
    );
    expect(cursorWrites.at(-1)!.params[1]).toBe(0);
    expect(cursorWrites.at(-1)!.params[2]).toBe(now.toISOString());
  });

  it("honours the page budget on a catalog larger than one run", async () => {
    const db = stubDb([730]);
    let pages = 0;
    const fetchImpl = vi.fn(async (input: URL | RequestInfo) => {
      const url = String(input);
      if (url.includes("GetAppList")) {
        pages++;
        return new Response(
          JSON.stringify({
            response: { apps: [{ appid: 900 + pages, name: `App ${pages}` }], last_appid: 900 + pages, have_more_results: true },
          }),
          { status: 200 },
        );
      }
      if (url.includes("ISteamChartsService")) return new Response(JSON.stringify({ response: { ranks: [] } }), { status: 200 });
      if (url.includes("featuredcategories")) return new Response("{}", { status: 200 });
      if (url.includes("appdetails")) return new Response(JSON.stringify({ "730": { success: false } }), { status: 200 });
      return new Response(JSON.stringify({ appnews: { newsitems: [] } }), { status: 200 });
    }) as unknown as typeof fetch;

    await runLane("catalog", {
      execute: db.execute,
      fetchImpl,
      logger: silentLogger,
      now,
      steamApiKey: "test-key",
      limits: { catalogSeedPages: 3 },
    });
    expect(pages).toBe(3);
  });

  it("keeps the key out of the logged error when a page fails", async () => {
    const warn = vi.fn();
    const db = stubDb([730]);
    const fetchImpl = routedFetch({
      ...catalogRoutes,
      GetAppList: () => {
        throw new Error("upstream 403");
      },
    });
    const report = await runLane("catalog", {
      execute: db.execute,
      fetchImpl,
      logger: { ...silentLogger, warn },
      now,
      steamApiKey: "super-secret-key",
    });
    // A failed seed must not fail the lane; the refresh below it still ran.
    expect(report.appsSeeded).toBe(0);
    expect(report.appsPolled).toBe(1);
    expect(JSON.stringify(warn.mock.calls)).not.toContain("super-secret-key");
  });
});
