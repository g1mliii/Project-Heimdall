import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createTestDb, testDbAvailable, type TestDb } from "../../web/src/lib/testing/test-db";
import {
  demoteInactiveApps,
  readStaleCatalogApps,
  readTrackedApps,
  upsertTrackedApps,
  writeAppMetadata,
  writeAppUpdates,
  writePlayerCounts,
  writePriceSnapshots,
  writeReviewSnapshots,
  type SqlExecutor,
} from "./db";
import type { AppMetadata } from "./types";

const canRun = testDbAvailable("steam-ingest-db.test");

const APPID = 730;
const OTHER = 570;
const T0 = "2026-09-02T00:00:00.000Z";
const T1 = "2026-09-03T00:00:00.000Z";

function metadataFor(overrides: Partial<AppMetadata> = {}): AppMetadata {
  return {
    appid: APPID,
    name: "Counter-Strike 2",
    appType: "game",
    isFree: true,
    releaseDate: "2012-08-21",
    comingSoon: false,
    developers: ["Valve"],
    publishers: ["Valve"],
    metadataFetchedAt: T0,
    tags: [
      { appid: APPID, kind: "genre", name: "Action", rank: 0, lastSeenAt: T0 },
      { appid: APPID, kind: "category", name: "Multi-player", rank: 0, lastSeenAt: T0 },
    ],
    raw: {
      appid: APPID,
      source: "appdetails",
      payloadHash: "a".repeat(64),
      payload: { name: "Counter-Strike 2", metacritic: { score: 83 } },
      seenAt: T0,
    },
    ...overrides,
  };
}

describe.skipIf(!canRun)("steam ingest persistence", () => {
  let db: TestDb;
  let execute: SqlExecutor;

  beforeAll(async () => {
    db = await createTestDb();
    execute = (<Row>(text: string, params: readonly unknown[]) =>
      db.pool.query(text, params as unknown[]).then((result) => result.rows as Row[])) as SqlExecutor;
  }, 240_000);

  afterAll(async () => {
    await db?.teardown();
  });

  const trackedIds = async (pollTier: number | null = null) =>
    (await readTrackedApps(execute, pollTier)).map((app) => app.appid);

  const seed = () =>
    upsertTrackedApps(execute, [
      { appid: APPID, name: "Counter-Strike 2", pollTier: 1, trackingReason: "featured" },
      { appid: OTHER, name: "Dota 2", pollTier: 2, trackingReason: "featured" },
    ]);

  it("applies migration 0041 with every table and the games link", async () => {
    const { rows } = await db.pool.query<{ table_name: string }>(
      `select table_name from information_schema.tables
        where table_schema = current_schema() and table_name like 'steam\\_%'
        order by table_name`,
    );
    // Subset, not equality: this test owns 0041, and later migrations legitimately
    // add more `steam_` tables (0042 adds the PICS build-identity ones). An
    // exhaustive assertion here fails every future migration for no defect.
    expect(rows.map((row) => row.table_name)).toEqual(
      expect.arrayContaining([
        "steam_app_changes",
        "steam_app_tags",
        "steam_app_updates",
        "steam_apps",
        "steam_player_counts",
        "steam_price_snapshots",
        "steam_raw_snapshots",
        "steam_review_snapshots",
      ]),
    );
    const { rows: linked } = await db.pool.query(
      `select column_name from information_schema.columns
        where table_schema = current_schema() and table_name = 'games'
          and column_name = 'steam_appid'`,
    );
    expect(linked).toHaveLength(1);
  });

  it("seeds tracked apps and reads them back by tier", async () => {
    expect(await seed()).toBe(2);
    expect(await trackedIds()).toEqual([APPID, OTHER]);
    expect(await trackedIds(1)).toEqual([APPID]);
  });

  it("never widens a hand-narrowed poll tier", async () => {
    await db.pool.query(`update steam_apps set poll_tier = 0 where appid = $1`, [OTHER]);
    await seed();
    const { rows } = await db.pool.query<{ poll_tier: number }>(
      `select poll_tier from steam_apps where appid = $1`,
      [OTHER],
    );
    expect(rows[0]!.poll_tier).toBe(0);
    expect(await trackedIds()).toEqual([APPID]);
    await db.pool.query(`update steam_apps set poll_tier = 2 where appid = $1`, [OTHER]);
  });

  it("writes a player count once per bucket, however often the lane retries", async () => {
    const sample = { appid: APPID, bucket: "2026-09-02T16:00:00.000Z", players: 844861 };
    expect(await writePlayerCounts(execute, [sample])).toBe(1);
    expect(await writePlayerCounts(execute, [sample])).toBe(0);
    expect(await writePlayerCounts(execute, [{ ...sample, players: 999 }])).toBe(0);
    const { rows } = await db.pool.query<{ players: number }>(
      `select players from steam_player_counts where appid = $1`,
      [APPID],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.players).toBe(844861);
  });

  it("drops an unknown appid instead of aborting the whole batch", async () => {
    const written = await writePlayerCounts(execute, [
      { appid: 99_999_999, bucket: "2026-09-02T17:00:00.000Z", players: 1 },
      { appid: APPID, bucket: "2026-09-02T17:00:00.000Z", players: 42 },
    ]);
    expect(written).toBe(1);
  });

  it("stores review and price snapshots idempotently", async () => {
    const review = {
      appid: APPID,
      bucket: "2026-09-02T16:00:00.000Z",
      reviewScore: 8,
      reviewScoreDesc: "Very Positive",
      totalPositive: 8447162,
      totalNegative: 1385617,
      totalReviews: 9832779,
    };
    expect(await writeReviewSnapshots(execute, [review])).toBe(1);
    expect(await writeReviewSnapshots(execute, [review])).toBe(0);

    const price = {
      appid: APPID,
      countryCode: "us",
      bucket: "2026-09-02T12:00:00.000Z",
      currency: "USD",
      initialCents: 5999,
      finalCents: 2999,
      discountPercent: 50,
    };
    expect(await writePriceSnapshots(execute, [price])).toBe(1);
    expect(await writePriceSnapshots(execute, [price])).toBe(0);
  });

  it("records no change on the first metadata observation", async () => {
    const report = await writeAppMetadata(execute, [metadataFor()]);
    expect(report).toEqual({ upserted: 1, changes: 0, tags: 2, rawSnapshots: 1 });
  });

  it("logs only the fields that actually changed on a later read", async () => {
    await writeAppMetadata(execute, [
      metadataFor({
        metadataFetchedAt: T1,
        isFree: false,
        publishers: ["Valve", "Perfect World"],
        raw: { ...metadataFor().raw, payloadHash: "b".repeat(64), seenAt: T1 },
        tags: [{ appid: APPID, kind: "genre", name: "Action", rank: 0, lastSeenAt: T1 }],
      }),
    ]);
    const { rows } = await db.pool.query<{ field: string; old_value: string; new_value: string }>(
      `select field, old_value, new_value from steam_app_changes
        where appid = $1 order by field`,
      [APPID],
    );
    expect(rows).toEqual([
      { field: "is_free", old_value: "true", new_value: "false" },
      { field: "publishers", old_value: "Valve", new_value: "Valve, Perfect World" },
    ]);
  });

  it("keeps a tag that vanished upstream, with its older last_seen_at", async () => {
    const { rows } = await db.pool.query<{ kind: string; name: string; last_seen_at: Date }>(
      `select kind, name, last_seen_at from steam_app_tags where appid = $1 order by kind, name`,
      [APPID],
    );
    expect(rows.map((row) => `${row.kind}:${row.name}`)).toEqual([
      "category:Multi-player",
      "genre:Action",
    ]);
    // The category was absent from the second read, so it kept T0.
    const category = rows.find((row) => row.kind === "category")!;
    const genre = rows.find((row) => row.kind === "genre")!;
    expect(category.last_seen_at.toISOString()).toBe(T0);
    expect(genre.last_seen_at.toISOString()).toBe(T1);
  });

  it("keeps one raw row per distinct payload and advances last_seen_at otherwise", async () => {
    const { rows: before } = await db.pool.query<{ count: string }>(
      `select count(*) from steam_raw_snapshots where appid = $1`,
      [APPID],
    );
    expect(Number(before[0]!.count)).toBe(2);

    // Re-reading an already-stored payload must add nothing.
    const T2 = "2026-09-04T00:00:00.000Z";
    await writeAppMetadata(execute, [
      metadataFor({
        metadataFetchedAt: T2,
        isFree: false,
        publishers: ["Valve", "Perfect World"],
        raw: { ...metadataFor().raw, payloadHash: "b".repeat(64), seenAt: T2 },
      }),
    ]);
    const { rows: after } = await db.pool.query<{ count: string; last: Date }>(
      `select count(*)::text as count, max(last_seen_at) as last
         from steam_raw_snapshots where appid = $1`,
      [APPID],
    );
    expect(Number(after[0]!.count)).toBe(2);
    expect(after[0]!.last.toISOString()).toBe(T2);
  });

  it("refuses to overwrite fresher metadata with a staler read", async () => {
    const stale = await writeAppMetadata(execute, [
      metadataFor({ metadataFetchedAt: T0, name: "Stale Name" }),
    ]);
    expect(stale.upserted).toBe(0);
    expect(stale.changes).toBe(0);
    const { rows } = await db.pool.query<{ name: string }>(
      `select name from steam_apps where appid = $1`,
      [APPID],
    );
    expect(rows[0]!.name).toBe("Counter-Strike 2");
  });

  it("upserts news items by gid and latches the patch-note flag", async () => {
    const item = {
      appid: APPID,
      gid: "g1",
      postedAt: "2026-09-01T00:00:00.000Z",
      title: "Counter-Strike 2 Update",
      url: "https://store.steampowered.com/news/app/730/view/g1",
      feedname: "steam_community_announcements",
      isPatchnote: true,
    };
    expect(await writeAppUpdates(execute, [item])).toBe(1);
    // A later re-read that lost the tag must not un-flag a known patch note.
    await writeAppUpdates(execute, [{ ...item, isPatchnote: false, title: "CS2 Update (edited)" }]);
    const { rows } = await db.pool.query<{ is_patchnote: boolean; title: string }>(
      `select is_patchnote, title from steam_app_updates where appid = $1 and gid = 'g1'`,
      [APPID],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.is_patchnote).toBe(true);
    expect(rows[0]!.title).toBe("CS2 Update (edited)");
  });

  it("rotates the catalog lane by staleness, never-fetched first", async () => {
    await upsertTrackedApps(execute, [
      { appid: 440, name: "Team Fortress 2", pollTier: 2, trackingReason: "featured" },
    ]);
    // 440 and 570 have never been fetched; 730 has.
    expect(await readStaleCatalogApps(execute, 3)).toEqual([440, OTHER, APPID]);
    expect(await readStaleCatalogApps(execute, 1)).toEqual([440]);
  });

  it("links a canonical game to a steam app, and only once", async () => {
    await db.pool.query(`insert into games (slug, name) values ('counter-strike-2', 'CS2')`);
    await db.pool.query(`update games set steam_appid = $1 where slug = 'counter-strike-2'`, [APPID]);
    await db.pool.query(`insert into games (slug, name) values ('cs2-dupe', 'CS2 Dupe')`);
    await expect(
      db.pool.query(`update games set steam_appid = $1 where slug = 'cs2-dupe'`, [APPID]),
    ).rejects.toThrow(/games_steam_appid_key/);
  });

  const DLC = 111_111;

  it("parks an app that has never once reported a player count", async () => {
    await upsertTrackedApps(execute, [
      { appid: DLC, name: "Some Soundtrack", pollTier: 2, trackingReason: "featured" },
    ]);
    // Steam answers `result != 1` for DLC, tools, demos and soundtracks, so the
    // players lane wrote no row for this app and never will. Keying the grace
    // window on one exempted exactly the class the pass exists to shed.
    await db.pool.query(
      `update steam_apps set first_seen_at = now() - interval '8 days' where appid = $1`,
      [DLC],
    );
    expect(await demoteInactiveApps(execute, 50)).toBe(1);
    const { rows } = await db.pool.query<{ poll_tier: number; parked_at: Date | null }>(
      `select poll_tier, parked_at from steam_apps where appid = $1`,
      [DLC],
    );
    expect(rows[0]!.poll_tier).toBe(0);
    // Recorded, so a later re-discovery can tell the poller's parking from an
    // operator's.
    expect(rows[0]!.parked_at).not.toBeNull();
  });

  it("spares an entrant it has not watched for a day yet", async () => {
    const FRESH = 222_222;
    await upsertTrackedApps(execute, [
      { appid: FRESH, name: "Brand New", pollTier: 2, trackingReason: "featured" },
    ]);
    expect(await demoteInactiveApps(execute, 50)).toBe(0);
    const { rows } = await db.pool.query<{ poll_tier: number }>(
      `select poll_tier from steam_apps where appid = $1`,
      [FRESH],
    );
    expect(rows[0]!.poll_tier).toBe(2);
  });

  it("re-promotes a parked app the moment it charts, but not when featured re-lists it", async () => {
    // Featured re-discovery is the noise the parking pass exists to shed.
    await upsertTrackedApps(execute, [
      { appid: DLC, name: "Some Soundtrack", pollTier: 2, trackingReason: "featured" },
    ]);
    expect(await trackedIds()).not.toContain(DLC);

    await upsertTrackedApps(execute, [
      { appid: DLC, name: "Some Soundtrack", pollTier: 1, trackingReason: "charts" },
    ]);
    const { rows } = await db.pool.query<{
      poll_tier: number;
      parked_at: Date | null;
      promoted_at: Date | null;
    }>(`select poll_tier, parked_at, promoted_at from steam_apps where appid = $1`, [DLC]);
    expect(rows[0]!.poll_tier).toBe(1);
    expect(rows[0]!.parked_at).toBeNull();
    expect(rows[0]!.promoted_at).not.toBeNull();
    expect(await trackedIds()).toContain(DLC);

    // A new tracked stretch gets its own day of grace, so the same pass cannot
    // immediately re-park it on the empty week it spent at tier 0.
    expect(await demoteInactiveApps(execute, 50)).toBe(0);
  });

  it("keeps an operator's hand-narrowed tier 0 parked even when it charts", async () => {
    const HAND = 333_333;
    await upsertTrackedApps(execute, [
      { appid: HAND, name: "Hand Parked", pollTier: 2, trackingReason: "featured" },
    ]);
    await db.pool.query(`update steam_apps set poll_tier = 0 where appid = $1`, [HAND]);
    await upsertTrackedApps(execute, [
      { appid: HAND, name: "Hand Parked", pollTier: 1, trackingReason: "charts" },
    ]);
    const { rows } = await db.pool.query<{ poll_tier: number }>(
      `select poll_tier from steam_apps where appid = $1`,
      [HAND],
    );
    expect(rows[0]!.poll_tier).toBe(0);
  });

  it("nulls the game link rather than deleting the game when an app goes away", async () => {
    await db.pool.query(`delete from steam_apps where appid = $1`, [440]);
    await db.pool.query(
      `insert into steam_apps (appid, name) values (440, 'Team Fortress 2')
       on conflict (appid) do nothing`,
    );
    await db.pool.query(`update games set steam_appid = 440 where slug = 'cs2-dupe'`);
    await db.pool.query(`delete from steam_apps where appid = 440`);
    const { rows } = await db.pool.query<{ steam_appid: string | null }>(
      `select steam_appid from games where slug = 'cs2-dupe'`,
    );
    expect(rows[0]!.steam_appid).toBeNull();
  });
});
