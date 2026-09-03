import { describe, expect, it, vi } from "vitest";

import { collectOnce, summarise } from "./collect.js";
import type { SqlExecutor } from "./db.js";
import type { ProductInfoApp, SteamClient } from "./steam.js";

interface Recorded {
  text: string;
  params: readonly unknown[];
}

/** Records writes; answers the tracked-apps and cursor reads. */
function stubDb(trackedApps: number[], cursor: number | null = null) {
  const calls: Recorded[] = [];
  const execute = vi.fn(async (text: string, params: readonly unknown[]) => {
    calls.push({ text, params });
    // Order matters: every upsert carries a `from steam_apps` guard clause in
    // its `where exists`, so the reads must be matched by their leading verb
    // rather than by a substring that the writes also contain.
    if (text.trimStart().startsWith("insert into steam_pics_cursor")) return [{ changenumber: "1" }];
    if (text.trimStart().startsWith("select appid")) {
      return trackedApps.map((appid) => ({ appid: String(appid) }));
    }
    if (text.trimStart().startsWith("select changenumber")) {
      return cursor === null ? [] : [{ changenumber: String(cursor) }];
    }
    // Upserts report one row per written row; treat them all as new.
    return (JSON.parse(String(params[0])) as unknown[]).map(() => ({ inserted: true }));
  }) as unknown as SqlExecutor;

  const written = (table: string) =>
    calls
      .filter((call) => call.text.includes(`insert into ${table}`))
      .flatMap((call) => JSON.parse(String(call.params[0])) as Record<string, unknown>[]);

  return { calls, execute, written };
}

const silent = { info: vi.fn(), warn: vi.fn() };
const now = new Date("2026-09-03T02:00:00.000Z");

function stubClient(
  apps: Record<number, unknown>,
  overrides: Partial<SteamClient> = {},
): SteamClient {
  return {
    getProductChanges: async () => ({ currentChangeNumber: 999, appIds: Object.keys(apps).map(Number) }),
    getProductInfo: async (appids: readonly number[]) => {
      const out = new Map<number, ProductInfoApp>();
      for (const appid of appids) {
        if (appid in apps) out.set(appid, { changenumber: 500, appinfo: apps[appid] });
      }
      return out;
    },
    close: () => {},
    ...overrides,
  };
}

const cs2 = {
  common: { name: "Counter-Strike 2", type: "Game" },
  depots: {
    branches: { public: { buildid: "25000182", timeupdated: "1787950286" } },
    "731": { manifests: { public: { gid: "6967806384656644903", size: "8" } } },
  },
};

describe("collectOnce", () => {
  it("refreshes every tracked app and records builds, depots and manifests", async () => {
    const db = stubDb([730]);
    const report = await collectOnce({
      execute: db.execute,
      client: stubClient({ 730: cs2 }),
      logger: silent,
      now,
    });
    expect(report.appsQueried).toBe(1);
    expect(report.builds.inserted).toBe(1);
    expect(db.written("steam_app_builds")[0]).toMatchObject({
      appid: 730,
      branch: "public",
      buildid: "25000182",
      seen_at: now.toISOString(),
    });
    expect(db.written("steam_app_depot_manifests")[0]!.manifest_gid).toBe("6967806384656644903");
  });

  it("refreshes the full tracked set, NOT just what the changelist reported", async () => {
    // The changelist names only 730, but 570 must still be refreshed — the
    // changelist silently truncates after a gap, so it cannot gate collection.
    const db = stubDb([730, 570]);
    const client = stubClient(
      { 730: cs2, 570: { common: { name: "Dota 2", type: "game" }, depots: { branches: { public: { buildid: "1" } } } } },
      { getProductChanges: async () => ({ currentChangeNumber: 999, appIds: [730] }) },
    );
    const report = await collectOnce({ execute: db.execute, client, logger: silent, now });
    expect(report.appsQueried).toBe(2);
    expect(report.changedAppsSeen).toBe(1);
    expect(db.written("steam_app_builds").map((row) => row.appid).sort()).toEqual([570, 730]);
  });

  it("still collects when the changelist call fails outright", async () => {
    const db = stubDb([730]);
    const warn = vi.fn();
    const client = stubClient({ 730: cs2 }, {
      getProductChanges: async () => {
        throw new Error("cm unavailable");
      },
    });
    const report = await collectOnce({
      execute: db.execute,
      client,
      logger: { ...silent, warn },
      now,
    });
    expect(report.builds.inserted).toBe(1);
    expect(report.cursor).toBeNull();
    expect(warn).toHaveBeenCalledWith("pics changelist unavailable", expect.anything());
  });

  it("keeps the batches that succeeded when one batch throws", async () => {
    const db = stubDb([1, 2, 3, 4]);
    let call = 0;
    const client = stubClient({ 1: cs2, 2: cs2, 3: cs2, 4: cs2 }, {
      getProductInfo: async (appids: readonly number[]) => {
        if (call++ === 0) throw new Error("upstream reset");
        const out = new Map<number, ProductInfoApp>();
        for (const appid of appids) out.set(appid, { changenumber: 1, appinfo: cs2 });
        return out;
      },
    });
    const report = await collectOnce({
      execute: db.execute,
      client,
      logger: silent,
      now,
      batchSize: 2,
    });
    expect(report.batchesFailed).toBe(1);
    expect(report.builds.inserted).toBe(2); // the surviving batch
  });

  it("advances the cursor only after the writes land", async () => {
    const db = stubDb([730], 100);
    await collectOnce({ execute: db.execute, client: stubClient({ 730: cs2 }), logger: silent, now });
    const order = db.calls.map((call) => call.text.trimStart().slice(0, 40));
    const buildWrite = order.findIndex((t) => t.startsWith("insert into steam_app_builds"));
    const cursorWrite = order.findIndex((t) => t.startsWith("insert into steam_pics_cursor"));
    expect(buildWrite).toBeGreaterThanOrEqual(0);
    expect(cursorWrite).toBeGreaterThan(buildWrite);
  });

  it("writes nothing and reports zero for an empty working set", async () => {
    const db = stubDb([]);
    const report = await collectOnce({
      execute: db.execute,
      client: stubClient({}),
      logger: silent,
      now,
    });
    expect(report).toMatchObject({ appsQueried: 0, builds: { inserted: 0, refreshed: 0 } });
    expect(db.written("steam_app_builds")).toEqual([]);
  });
});

describe("summarise", () => {
  it("redacts a connection string", () => {
    expect(summarise(new Error("failed for postgresql://u:p@host/db"))).toContain(
      "[redacted database URL]",
    );
  });

  it("never leaks a non-Error throw", () => {
    expect(summarise({ secret: "x" })).toBe("unknown pics error");
  });
});
