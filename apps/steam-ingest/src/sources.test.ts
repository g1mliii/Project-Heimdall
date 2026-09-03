import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

import {
  bucketFor,
  fetchAppMetadata,
  fetchAppUpdates,
  fetchAppName,
  fetchFeaturedApps,
  fetchPlayerCount,
  fetchPriceBatch,
  fetchReviewSummary,
  fetchTopAppIds,
  LANE_CADENCE_MS,
  parseReleaseDate,
  payloadHash,
} from "./sources";

const fixture = (name: string) =>
  readFile(path.resolve(import.meta.dirname, "../fixtures", name), "utf8");

/** Serves one captured fixture regardless of URL; each test drives one call. */
const serving = async (name: string) => {
  const body = await fixture(name);
  return vi.fn(
    async () =>
      new Response(body, { status: 200, headers: { "content-type": "application/json" } }),
  ) as unknown as typeof fetch;
};

const bucket = "2026-09-02T16:00:00.000Z";

describe("player counts", () => {
  it("reads the confirmed payload", async () => {
    const fetchImpl = await serving("player-count.json");
    await expect(fetchPlayerCount(730, { fetchImpl })).resolves.toBe(844861);
  });

  it("returns null when Steam declines to report, rather than throwing", async () => {
    const fetchImpl = vi.fn(
      async () => new Response(JSON.stringify({ response: { result: 42 } }), { status: 200 }),
    ) as unknown as typeof fetch;
    await expect(fetchPlayerCount(730, { fetchImpl })).resolves.toBeNull();
  });

  it("rejects a negative or non-numeric count", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify({ response: { result: 1, player_count: -5 } }), { status: 200 }),
    ) as unknown as typeof fetch;
    await expect(fetchPlayerCount(730, { fetchImpl })).resolves.toBeNull();
  });
});

describe("review summaries", () => {
  // These are the ALL-LANGUAGE totals, which is what `language=all` in the
  // production URL asks for. Dropping that parameter returns the store's default
  // English-only slice (~2.2M positive for this app at capture time) — a quietly
  // different series, so the fixture pins the parameter as much as the parser.
  it("reads the confirmed payload", async () => {
    const fetchImpl = await serving("app-reviews.json");
    await expect(fetchReviewSummary(730, bucket, { fetchImpl })).resolves.toEqual({
      appid: 730,
      bucket,
      reviewScore: 8,
      reviewScoreDesc: "Very Positive",
      totalPositive: 8447162,
      totalNegative: 1385617,
      totalReviews: 9832779,
    });
  });

  it("keeps totals and drops an out-of-range band rather than the whole row", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            success: 1,
            query_summary: {
              review_score: 99,
              total_positive: 1,
              total_negative: 2,
              total_reviews: 3,
            },
          }),
          { status: 200 },
        ),
    ) as unknown as typeof fetch;
    const sample = await fetchReviewSummary(730, bucket, { fetchImpl });
    expect(sample).toMatchObject({ reviewScore: null, totalReviews: 3 });
  });
});

describe("price batches", () => {
  it("reads the confirmed batch and skips the free app's empty data", async () => {
    const fetchImpl = await serving("price-batch.json");
    const samples = await fetchPriceBatch([730, 1091500], "us", bucket, { fetchImpl });
    expect(samples).toEqual([
      {
        appid: 1091500,
        countryCode: "us",
        bucket,
        currency: "USD",
        initialCents: 5999,
        finalCents: 5999,
        discountPercent: 0,
      },
    ]);
  });

  it("costs no subrequest for an empty batch", async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    await expect(fetchPriceBatch([], "us", bucket, { fetchImpl })).resolves.toEqual([]);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("refuses a malformed country code before building a URL", async () => {
    await expect(fetchPriceBatch([730], "USA", bucket)).rejects.toThrow(/two lowercase letters/);
  });
});

describe("app metadata", () => {
  it("reads the confirmed store payload", async () => {
    const fetchImpl = await serving("app-details.json");
    await expect(
      fetchAppMetadata(1091500, "2026-09-02T16:00:00.000Z", { fetchImpl }),
    ).resolves.toMatchObject({
      appid: 1091500,
      name: "Cyberpunk 2077",
      appType: "game",
      isFree: false,
      releaseDate: "2020-12-09",
      comingSoon: false,
      developers: ["CD PROJEKT RED"],
      publishers: ["CD PROJEKT RED"],
    });
  });

  it("carries genres and categories as ranked tags", async () => {
    const fetchImpl = await serving("app-details.json");
    const meta = await fetchAppMetadata(1091500, "2026-09-02T16:00:00.000Z", { fetchImpl });
    const genres = meta!.tags.filter((tag) => tag.kind === "genre");
    const categories = meta!.tags.filter((tag) => tag.kind === "category");
    expect(genres).toEqual([
      { appid: 1091500, kind: "genre", name: "RPG", rank: 0, lastSeenAt: "2026-09-02T16:00:00.000Z" },
    ]);
    expect(categories.map((tag) => tag.name)).toContain("Single-player");
    // Rank preserves Steam's own ordering, densely, per kind.
    expect(categories.map((tag) => tag.rank)).toEqual(categories.map((_, i) => i));
  });

  it("retains the whole payload, including fields no column models", async () => {
    const fetchImpl = await serving("app-details.json");
    const meta = await fetchAppMetadata(1091500, "2026-09-02T16:00:00.000Z", { fetchImpl });
    expect(meta!.raw.source).toBe("appdetails");
    expect(meta!.raw.payloadHash).toMatch(/^[0-9a-f]{64}$/);
    const payload = meta!.raw.payload as Record<string, unknown>;
    // None of these have a column; all must stay recoverable without a migration.
    expect(payload.metacritic).toEqual({ score: 86, url: expect.any(String) });
    expect(payload.platforms).toEqual({ windows: true, mac: true, linux: false });
    expect(payload.dlc).toEqual([2138330, 1495710, 2060310]);
    expect(payload.pc_requirements).toHaveProperty("minimum");
  });

  it("returns null for an app the store does not serve", async () => {
    const fetchImpl = vi.fn(
      async () => new Response(JSON.stringify({ "1": { success: false } }), { status: 200 }),
    ) as unknown as typeof fetch;
    await expect(fetchAppMetadata(1, bucket, { fetchImpl })).resolves.toBeNull();
  });
});

describe("app updates", () => {
  it("reads the confirmed news feed and flags tagged patch notes", async () => {
    const fetchImpl = await serving("app-news.json");
    const updates = await fetchAppUpdates(730, { fetchImpl });
    expect(updates).toHaveLength(20);
    expect(updates.filter((update) => update.isPatchnote).length).toBeGreaterThanOrEqual(13);
    expect(updates[0]).toMatchObject({
      appid: 730,
      gid: "1841579228676851",
      title: "Counter-Strike 2 Update",
      isPatchnote: true,
    });
    expect(Date.parse(updates[0]!.postedAt)).toBe(1787614760 * 1000);
  });

  it("flags an untagged patch note by title, and leaves other posts unknown", async () => {
    const newsitems = [
      { gid: "a", title: "Hotfix 1.2.1 deployed", date: 1_700_000_000, tags: [] },
      { gid: "b", title: "Community art contest", date: 1_700_000_001, tags: [] },
    ];
    const fetchImpl = vi.fn(
      async () => new Response(JSON.stringify({ appnews: { newsitems } }), { status: 200 }),
    ) as unknown as typeof fetch;
    const updates = await fetchAppUpdates(730, { fetchImpl });
    expect(updates.map((update) => update.isPatchnote)).toEqual([true, false]);
  });

  it("drops an item missing a gid or date instead of failing the feed", async () => {
    const newsitems = [
      { title: "no gid", date: 1_700_000_000 },
      { gid: "b", title: "kept", date: 1_700_000_001 },
    ];
    const fetchImpl = vi.fn(
      async () => new Response(JSON.stringify({ appnews: { newsitems } }), { status: 200 }),
    ) as unknown as typeof fetch;
    await expect(fetchAppUpdates(730, { fetchImpl })).resolves.toHaveLength(1);
  });
});

describe("featured discovery", () => {
  it("collects appids across every category that carries them", async () => {
    const fetchImpl = await serving("featured-categories.json");
    const featured = await fetchFeaturedApps({ fetchImpl });
    expect(featured.length).toBeGreaterThan(20);
    expect(new Set(featured.map((app) => app.appid)).size).toBe(featured.length);
    for (const app of featured) {
      expect(Number.isSafeInteger(app.appid)).toBe(true);
      expect(app.name).not.toHaveLength(0);
    }
  });

  it("ignores spotlight entries that carry no appid", async () => {
    const body = {
      cat_spotlight: { items: [{ name: "MIDWEEK DEAL", url: "https://store.steampowered.com/x" }] },
      top_sellers: { items: [{ id: 730, name: "Counter-Strike 2" }] },
    };
    const fetchImpl = vi.fn(
      async () => new Response(JSON.stringify(body), { status: 200 }),
    ) as unknown as typeof fetch;
    await expect(fetchFeaturedApps({ fetchImpl })).resolves.toEqual([
      { appid: 730, name: "Counter-Strike 2" },
    ]);
  });
});

describe("bucketFor", () => {
  it("floors to the lane cadence so a retry lands on the same key", () => {
    const cadence = LANE_CADENCE_MS.players;
    expect(bucketFor(new Date("2026-09-02T16:07:41.512Z"), cadence)).toBe("2026-09-02T16:00:00.000Z");
    expect(bucketFor(new Date("2026-09-02T16:09:59.999Z"), cadence)).toBe("2026-09-02T16:00:00.000Z");
    expect(bucketFor(new Date("2026-09-02T16:10:00.000Z"), cadence)).toBe("2026-09-02T16:10:00.000Z");
  });

  it("gives each lane its own grid", () => {
    const at = new Date("2026-09-02T16:07:41.512Z");
    expect(bucketFor(at, LANE_CADENCE_MS.reviews)).toBe("2026-09-02T16:00:00.000Z");
    expect(bucketFor(at, LANE_CADENCE_MS.prices)).toBe("2026-09-02T12:00:00.000Z");
    expect(bucketFor(at, LANE_CADENCE_MS.catalog)).toBe("2026-09-02T00:00:00.000Z");
  });

  it("refuses a nonsensical cadence", () => {
    expect(() => bucketFor(new Date(), 0)).toThrow(/positive number/);
  });
});

describe("parseReleaseDate", () => {
  it("accepts both exact day forms the store emits", () => {
    expect(parseReleaseDate("Dec 9, 2020")).toBe("2020-12-09");
    expect(parseReleaseDate("9 Dec, 2020")).toBe("2020-12-09");
    expect(parseReleaseDate("December 9, 2020")).toBe("2020-12-09");
  });

  it("returns null for the vague forms rather than inventing a day", () => {
    for (const value of ["2021", "Q1 2022", "Coming soon", "To be announced", "", undefined, 42]) {
      expect(parseReleaseDate(value)).toBeNull();
    }
  });

  it("rejects a day that does not exist in that month", () => {
    expect(parseReleaseDate("Feb 31, 2020")).toBeNull();
  });
});

describe("payloadHash", () => {
  it("ignores key order, so a reordered response is not a change", async () => {
    const a = await payloadHash({ name: "CS2", type: "game", nested: { x: 1, y: 2 } });
    const b = await payloadHash({ type: "game", nested: { y: 2, x: 1 }, name: "CS2" });
    expect(a).toBe(b);
  });

  it("changes when any value changes", async () => {
    const before = await payloadHash({ name: "CS2", price: 0 });
    const after = await payloadHash({ name: "CS2", price: 1 });
    expect(before).not.toBe(after);
  });

  it("preserves array order, which is meaningful", async () => {
    const a = await payloadHash({ developers: ["Valve", "Hidden Path"] });
    const b = await payloadHash({ developers: ["Hidden Path", "Valve"] });
    expect(a).not.toBe(b);
  });
});

describe("charts discovery", () => {
  /** Serves the CCU chart first, then the weekly chart, as the source does. */
  const bothCharts = async () => {
    const ccu = await fixture("charts-concurrent.json");
    const weekly = await fixture("charts-mostplayed.json");
    return vi.fn(async (input: URL | RequestInfo) =>
      new Response(String(input).includes("GetGamesByConcurrentPlayers") ? ccu : weekly, {
        status: 200,
      }),
    ) as unknown as typeof fetch;
  };

  it("unions both charts, de-duplicated, in rank order", async () => {
    const fetchImpl = await bothCharts();
    const ranked = await fetchTopAppIds({ fetchImpl });
    expect(ranked.length).toBeGreaterThan(100);
    expect(new Set(ranked).size).toBe(ranked.length);
    // The live-CCU chart is queried first, so its #1 leads the union.
    expect(ranked[0]).toBe(730);
    for (const appid of ranked) expect(Number.isSafeInteger(appid)).toBe(true);
  });

  it("still returns the other chart when one is down", async () => {
    const ccu = await fixture("charts-concurrent.json");
    const fetchImpl = vi.fn(async (input: URL | RequestInfo) => {
      if (String(input).includes("GetMostPlayedGames")) throw new Error("upstream 503");
      return new Response(ccu, { status: 200 });
    }) as unknown as typeof fetch;
    await expect(fetchTopAppIds({ fetchImpl })).resolves.toHaveLength(100);
  });

  it("returns nothing rather than throwing when both are down", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("upstream 503");
    }) as unknown as typeof fetch;
    await expect(fetchTopAppIds({ fetchImpl })).resolves.toEqual([]);
  });
});

describe("fetchAppName", () => {
  it("reads a name from the single-app basic form", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify({ "730": { success: true, data: { type: "Game", name: "Counter-Strike 2" } } }), {
          status: 200,
        }),
    ) as unknown as typeof fetch;
    await expect(fetchAppName(730, { fetchImpl })).resolves.toBe("Counter-Strike 2");
  });

  it("accepts either casing of `type`, which Steam is inconsistent about", async () => {
    // Confirmed live: appid 570 answers "game", appid 730 answers "Game".
    for (const type of ["game", "Game"]) {
      const fetchImpl = vi.fn(
        async () => new Response(JSON.stringify({ "570": { success: true, data: { type, name: "Dota 2" } } }), { status: 200 }),
      ) as unknown as typeof fetch;
      await expect(fetchAppName(570, { fetchImpl })).resolves.toBe("Dota 2");
    }
  });

  it("rejects a non-game so hardware and soundtracks never enter the working set", async () => {
    const fetchImpl = vi.fn(
      async () => new Response(JSON.stringify({ "1": { success: true, data: { type: "Music", name: "CS2 Soundtrack" } } }), { status: 200 }),
    ) as unknown as typeof fetch;
    await expect(fetchAppName(1, { fetchImpl })).resolves.toBeNull();
  });
});
