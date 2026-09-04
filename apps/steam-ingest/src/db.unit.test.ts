import { describe, expect, it, vi } from "vitest";

import {
  DEMOTE_INACTIVE_APPS_SQL,
  LINK_GAMES_TO_STEAM_APPS_SQL,
  INSERT_PLAYER_COUNTS_SQL,
  INSERT_PRICE_SNAPSHOTS_SQL,
  INSERT_REVIEW_SNAPSHOTS_SQL,
  readStaleCatalogApps,
  readTrackedApps,
  STALE_CATALOG_APPS_SQL,
  TRACKED_APPS_SQL,
  UPSERT_APP_METADATA_SQL,
  UPSERT_APP_TAGS_SQL,
  UPSERT_APP_UPDATES_SQL,
  UPSERT_APPS_SQL,
  UPSERT_RAW_SNAPSHOTS_SQL,
  writeAppMetadata,
  writeAppUpdates,
  writePlayerCounts,
  writePriceSnapshots,
  writeReviewSnapshots,
  type SqlExecutor,
} from "./db";
import { POLL_TIER, TRACKING_REASON } from "./types";

/** Records every statement and its bound parameters. */
function recorder(rows: unknown[] = [{ ok: 1 }]) {
  const calls: Array<{ text: string; params: readonly unknown[] }> = [];
  const execute = vi.fn(async (text: string, params: readonly unknown[]) => {
    calls.push({ text, params });
    return rows;
  }) as unknown as SqlExecutor;
  return { calls, execute };
}

const WRITE_STATEMENTS = [
  UPSERT_APPS_SQL,
  INSERT_PLAYER_COUNTS_SQL,
  INSERT_REVIEW_SNAPSHOTS_SQL,
  INSERT_PRICE_SNAPSHOTS_SQL,
  UPSERT_APP_METADATA_SQL,
  UPSERT_APP_TAGS_SQL,
  UPSERT_APP_UPDATES_SQL,
  UPSERT_RAW_SNAPSHOTS_SQL,
];

describe("statement shape", () => {
  it("binds exactly one parameter per write, so no $n is hand-counted", () => {
    for (const statement of WRITE_STATEMENTS) {
      const placeholders = new Set(statement.match(/\$\d+/g) ?? []);
      expect([...placeholders]).toEqual(["$1"]);
    }
  });

  it("interpolates no values into any statement", () => {
    for (const statement of [...WRITE_STATEMENTS, TRACKED_APPS_SQL, STALE_CATALOG_APPS_SQL]) {
      expect(statement).not.toMatch(/\$\{/);
    }
  });

  it("keeps every time-series write idempotent on its bucket key", () => {
    expect(INSERT_PLAYER_COUNTS_SQL).toContain("on conflict (appid, bucket) do nothing");
    expect(INSERT_REVIEW_SNAPSHOTS_SQL).toContain("on conflict (appid, bucket) do nothing");
    expect(INSERT_PRICE_SNAPSHOTS_SQL).toContain(
      "on conflict (appid, country_code, bucket) do nothing",
    );
  });

  it("guards every child write against an unknown appid aborting the batch", () => {
    for (const statement of [
      INSERT_PLAYER_COUNTS_SQL,
      INSERT_REVIEW_SNAPSHOTS_SQL,
      INSERT_PRICE_SNAPSHOTS_SQL,
      UPSERT_APP_UPDATES_SQL,
    ]) {
      expect(statement).toContain("where exists (select 1 from steam_apps a where a.appid = x.appid)");
    }
  });
});

describe("empty batches", () => {
  it("cost no round trip", async () => {
    const { calls, execute } = recorder();
    await Promise.all([
      writePlayerCounts(execute, []),
      writeReviewSnapshots(execute, []),
      writePriceSnapshots(execute, []),
      writeAppMetadata(execute, []),
      writeAppUpdates(execute, []),
    ]);
    expect(calls).toHaveLength(0);
  });
});

describe("row mapping", () => {
  it("sends player counts as the column names the statement declares", async () => {
    const { calls, execute } = recorder();
    await writePlayerCounts(execute, [
      { appid: 730, bucket: "2026-09-02T16:00:00.000Z", players: 844861 },
    ]);
    expect(JSON.parse(calls[0]!.params[0] as string)).toEqual([
      { appid: 730, bucket: "2026-09-02T16:00:00.000Z", players: 844861 },
    ]);
  });

  it("snake-cases review columns", async () => {
    const { calls, execute } = recorder();
    await writeReviewSnapshots(execute, [
      {
        appid: 730,
        bucket: "2026-09-02T16:00:00.000Z",
        reviewScore: 8,
        reviewScoreDesc: "Very Positive",
        totalPositive: 10,
        totalNegative: 2,
        totalReviews: 12,
      },
    ]);
    expect(JSON.parse(calls[0]!.params[0] as string)[0]).toEqual({
      appid: 730,
      bucket: "2026-09-02T16:00:00.000Z",
      review_score: 8,
      review_score_desc: "Very Positive",
      total_positive: 10,
      total_negative: 2,
      total_reviews: 12,
    });
  });

  it("snake-cases price columns and keeps minor units integral", async () => {
    const { calls, execute } = recorder();
    await writePriceSnapshots(execute, [
      {
        appid: 1091500,
        countryCode: "us",
        bucket: "2026-09-02T12:00:00.000Z",
        currency: "USD",
        initialCents: 5999,
        finalCents: 2999,
        discountPercent: 50,
      },
    ]);
    expect(JSON.parse(calls[0]!.params[0] as string)[0]).toEqual({
      appid: 1091500,
      country_code: "us",
      bucket: "2026-09-02T12:00:00.000Z",
      currency: "USD",
      initial_cents: 5999,
      final_cents: 2999,
      discount_percent: 50,
    });
  });

  it("snake-cases update columns", async () => {
    const { calls, execute } = recorder();
    await writeAppUpdates(execute, [
      {
        appid: 730,
        gid: "abc",
        postedAt: "2026-09-01T00:00:00.000Z",
        title: "Counter-Strike 2 Update",
        url: null,
        feedname: "steam_community_announcements",
        isPatchnote: true,
      },
    ]);
    expect(JSON.parse(calls[0]!.params[0] as string)[0]).toEqual({
      appid: 730,
      gid: "abc",
      posted_at: "2026-09-01T00:00:00.000Z",
      title: "Counter-Strike 2 Update",
      url: null,
      feedname: "steam_community_announcements",
      is_patchnote: true,
    });
  });
});

describe("upsert posture", () => {
  it("never widens a hand-narrowed poll tier on re-discovery", () => {
    expect(UPSERT_APPS_SQL).toContain("least(steam_apps.poll_tier, excluded.poll_tier)");
  });

  it("re-promotes an app the POLLER parked, and only from the charts source", () => {
    // `least()` alone made tier 0 absorbing, so the demotion pass's own promise
    // — an app that takes off is re-promoted the moment it charts — could never
    // be kept. `parked_at` is what separates the poller's parking from an
    // operator's, which still takes the `least` branch and stays narrow.
    expect(UPSERT_APPS_SQL).toContain(
      `excluded.tracking_reason = '${TRACKING_REASON.charts}'`,
    );
    expect(UPSERT_APPS_SQL).not.toContain(
      `excluded.tracking_reason = '${TRACKING_REASON.featured}'`,
    );
  });

  it("decides the tier and both lifecycle dates from one named predicate", () => {
    // Three copies of the condition could drift into a half-state: a tier that
    // moved without its dates, or the reverse. One assignment, one predicate.
    expect(UPSERT_APPS_SQL).toContain("(poll_tier, promoted_at, parked_at) = (");
    expect(UPSERT_APPS_SQL.match(/steam_apps\.parked_at is not null/g)).toHaveLength(1);
  });

  it("refuses to overwrite fresher metadata with a staler read", () => {
    expect(UPSERT_APP_METADATA_SQL).toContain(
      "where excluded.metadata_fetched_at > coalesce(steam_apps.metadata_fetched_at, 'epoch'::timestamptz)",
    );
  });

  it("latches a known patch note so a re-read cannot un-flag it", () => {
    expect(UPSERT_APP_UPDATES_SQL).toContain(
      "is_patchnote = steam_app_updates.is_patchnote or excluded.is_patchnote",
    );
  });

  it("reads the pre-update row for the change log, not the row it just wrote", () => {
    // `prior` must be its own CTE over steam_apps so it sees the statement's
    // starting snapshot rather than the upsert's result.
    expect(UPSERT_APP_METADATA_SQL).toMatch(/prior as \(\s*select s\.appid/);
    expect(UPSERT_APP_METADATA_SQL).toContain("join prior p on p.appid = i.appid");
    expect(UPSERT_APP_METADATA_SQL).toContain("where d.old_value is distinct from d.new_value");
  });

  it("dedupes raw payloads by content hash rather than by day", () => {
    expect(UPSERT_RAW_SNAPSHOTS_SQL).toContain(
      "on conflict (appid, source, payload_hash) do update",
    );
    expect(UPSERT_RAW_SNAPSHOTS_SQL).toContain(
      "set last_seen_at = greatest(steam_raw_snapshots.last_seen_at, excluded.last_seen_at)",
    );
  });

  it("never deletes a tag that vanished upstream", () => {
    expect(UPSERT_APP_TAGS_SQL).not.toMatch(/\bdelete\b/i);
    expect(UPSERT_APP_TAGS_SQL).toContain("last_seen_at = greatest(");
  });
});

describe("demotion posture", () => {
  it("dates the grace window from the app, never from its samples", () => {
    // Steam answers `result != 1` for DLC, tools, demos and soundtracks, so the
    // players lane writes no row for them at all. Requiring an aged
    // steam_player_counts row exempted exactly the class this pass exists to
    // park, and the working set could only grow.
    expect(DEMOTE_INACTIVE_APPS_SQL).toContain(
      "coalesce(a.promoted_at, a.first_seen_at) <= now() - interval '24 hours'",
    );
    expect(DEMOTE_INACTIVE_APPS_SQL).not.toMatch(
      /exists\s*\(\s*select 1 from steam_player_counts p\s+where p\.appid = a\.appid and p\.bucket <=/,
    );
  });

  it("records that the poller was the one that parked the app", () => {
    expect(DEMOTE_INACTIVE_APPS_SQL).toContain(
      `set poll_tier = ${POLL_TIER.parked}, parked_at = now()`,
    );
  });

  it("still exempts a deliberate choice", () => {
    expect(DEMOTE_INACTIVE_APPS_SQL).toContain(
      `not in ('${TRACKING_REASON.curatedBenchmark}', '${TRACKING_REASON.charts}')`,
    );
  });
});

describe("game linking posture (8.7.9)", () => {
  it("only ever considers an app Steam itself calls a game", () => {
    // A DLC or soundtrack shares nearly every token with its base title, so no
    // threshold separates them — this guard does.
    expect(LINK_GAMES_TO_STEAM_APPS_SQL).toContain("a.app_type = 'game'");
  });

  it("requires a mutual best match, not just a good one", () => {
    expect(LINK_GAMES_TO_STEAM_APPS_SQL).toContain("game_rank = 1");
    expect(LINK_GAMES_TO_STEAM_APPS_SQL).toContain("app_rank = 1");
  });

  it("keeps the driver curator's threshold and safety margin, on both sides", () => {
    expect(LINK_GAMES_TO_STEAM_APPS_SQL).toContain("score >= 0.82");
    expect(LINK_GAMES_TO_STEAM_APPS_SQL).toContain("score - next_game_score >= 0.08");
    expect(LINK_GAMES_TO_STEAM_APPS_SQL).toContain("score - next_app_score >= 0.08");
  });

  it("gives an exact name match no escape from the ambiguity check", () => {
    // Two distinct games can share a name, and so can two apps; `priority = 3`
    // as a standalone pass would turn that tie into an arbitrary link.
    expect(LINK_GAMES_TO_STEAM_APPS_SQL).not.toContain("priority = 3");
  });

  it("only ever fills a null, so a hand-made link stands", () => {
    expect(LINK_GAMES_TO_STEAM_APPS_SQL).toContain("g.steam_appid is null");
    expect(LINK_GAMES_TO_STEAM_APPS_SQL.toLowerCase()).not.toContain("delete");
  });

  it("splits on whitespace, not on the letter s", () => {
    // `'\\s+'` in the template literal; a single backslash would collapse to a
    // literal "s" and tokenise every name at its s characters.
    expect(LINK_GAMES_TO_STEAM_APPS_SQL).toContain("'\\s+'");
  });
});

describe("reads", () => {
  it("coerces Neon's bigint strings and drops anything unsafe", async () => {
    const { execute } = recorder([
      { appid: "730", poll_tier: "1" },
      { appid: 1091500, poll_tier: 2 },
      { appid: "not-a-number", poll_tier: 2 },
    ]);
    await expect(readTrackedApps(execute)).resolves.toEqual([
      { appid: 730, pollTier: 1 },
      { appid: 1091500, pollTier: 2 },
    ]);
  });

  it("carries the tier, so a capped lane can honour the high-cadence set", () => {
    expect(TRACKED_APPS_SQL).toContain("select appid, poll_tier");
  });

  it("passes the tier filter through as a bound parameter", async () => {
    const { calls, execute } = recorder([]);
    await readTrackedApps(execute, 1);
    expect(calls[0]!.params).toEqual([1]);
  });

  it("refuses a nonsensical catalog limit before querying", async () => {
    const { calls, execute } = recorder([]);
    await expect(readStaleCatalogApps(execute, 0)).rejects.toThrow(/positive integer/);
    expect(calls).toHaveLength(0);
  });
});
