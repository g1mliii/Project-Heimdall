import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createTestDb, testDbAvailable, type TestDb } from "../../web/src/lib/testing/test-db";
import { persistCurationWith } from "./db";
import type { CurationBatch } from "./types";

const canRun = testDbAvailable("driver-curation-db.test");

describe.skipIf(!canRun)("driver curation persistence", () => {
  let db: TestDb;

  beforeAll(async () => {
    db = await createTestDb();
  }, 240_000);

  afterAll(async () => {
    await db?.teardown();
  });

  it("matches only existing games and remains idempotent", async () => {
    await db.pool.query(
      `insert into games (slug, name)
       values ('tom-clancy-rainbow-six-siege-deluxe-edition',
               'Tom Clancy Rainbow Six Siege Deluxe Edition')`,
    );
    await db.pool.query(
      `insert into games (slug, name)
       values ('aster-botanica-cerulean-deltora-evergreen-foxtrot',
               'Aster Botanica Cerulean Deltora Evergreen Foxtrot')`,
    );
    const gameCountBefore = await db.pool.query<{ count: string }>("select count(*) from games");
    const fetchedAt = new Date(Date.now() + 60 * 60 * 1_000).toISOString();
    const batch: CurationBatch = {
      catalog: [
        {
          vendor: "nvidia",
          os: "windows",
          component: "gpu",
          latestVersion: "611.00",
          releasedAt: "2026-07-14",
          sourceUrl: "https://www.nvidia.com/en-us/drivers/details/273100/",
          fetchedAt,
        },
      ],
      requirements: [
        {
          vendor: "nvidia",
          os: "windows",
          minVersion: "611.00",
          title: "Cyberpunk 2077",
          releasedAt: "2026-07-14",
          sourceUrl: "https://www.nvidia.com/en-us/drivers/details/273100/",
          fetchedAt,
        },
        {
          vendor: "nvidia",
          os: "windows",
          minVersion: "611.00",
          title: "Tom Clancy Rainbow Six Siege Deluxe Edition",
          releasedAt: "2026-07-14",
          sourceUrl: "https://www.nvidia.com/en-us/drivers/details/273100/",
          fetchedAt,
        },
        {
          vendor: "nvidia",
          os: "windows",
          minVersion: "611.00",
          title: "Tom Clancy Rainbow Six Siege Deluxe",
          releasedAt: "2026-07-14",
          sourceUrl: "https://www.nvidia.com/en-us/drivers/details/273100/",
          fetchedAt,
        },
        {
          vendor: "nvidia",
          os: "windows",
          minVersion: "611.00",
          title: "Aster Botanica Cerulean Deltora Evergreen Encyclopedia",
          releasedAt: "2026-07-14",
          sourceUrl: "https://www.nvidia.com/en-us/drivers/details/273100/",
          fetchedAt,
        },
        {
          vendor: "nvidia",
          os: "windows",
          minVersion: "611.00",
          title: "A Completely Unknown Game",
          releasedAt: "2026-07-14",
          sourceUrl: "https://www.nvidia.com/en-us/drivers/details/273100/",
          fetchedAt,
        },
      ],
    };
    const execute = async (text: string, params: readonly unknown[]) =>
      (await db.pool.query(text, [...params])).rows;

    const first = await persistCurationWith(execute, batch);
    expect(first).toMatchObject({
      catalogUpserted: 1,
      requirementsUpserted: 3,
      requirementsReceived: 5,
      requirementsMatched: 4,
      unmatchedTitles: ["A Completely Unknown Game"],
    });
    const second = await persistCurationWith(execute, batch);
    expect(second).toMatchObject({ catalogUpserted: 0, requirementsUpserted: 0 });

    const gameCountAfter = await db.pool.query<{ count: string }>("select count(*) from games");
    expect(gameCountAfter.rows[0]?.count).toBe(gameCountBefore.rows[0]?.count);
    const stored = await db.pool.query<{ latest_version: string }>(
      `select latest_version
         from driver_catalog
        where vendor = 'nvidia' and os = 'windows' and component = 'gpu'`,
    );
    expect(stored.rows).toEqual([{ latest_version: "611.00" }]);
    const requirements = await db.pool.query<{ name: string; min_version: string }>(
      `select g.name, requirement.min_version
         from game_driver_requirements requirement
         join games g on g.id = requirement.game_id
        where requirement.vendor = 'nvidia' and requirement.os = 'windows'
          and g.name in (
            'Aster Botanica Cerulean Deltora Evergreen Foxtrot',
            'Cyberpunk 2077',
            'Tom Clancy Rainbow Six Siege Deluxe Edition'
          )
        order by g.name`,
    );
    expect(requirements.rows).toEqual([
      {
        name: "Aster Botanica Cerulean Deltora Evergreen Foxtrot",
        min_version: "611.00",
      },
      { name: "Cyberpunk 2077", min_version: "611.00" },
      { name: "Tom Clancy Rainbow Six Siege Deluxe Edition", min_version: "611.00" },
    ]);

    await persistCurationWith(execute, {
      catalog: [
        {
          ...batch.catalog[0]!,
          latestVersion: "500.00",
          fetchedAt: new Date(Date.now() - 60 * 60 * 1_000).toISOString(),
        },
      ],
      requirements: [],
    });
    expect(
      (
        await db.pool.query<{ latest_version: string }>(
          `select latest_version
             from driver_catalog
            where vendor = 'nvidia' and os = 'windows' and component = 'gpu'`,
        )
      ).rows,
    ).toEqual([{ latest_version: "611.00" }]);

    await persistCurationWith(execute, {
      catalog: [
        {
          ...batch.catalog[0]!,
          latestVersion: "499.00",
          releasedAt: "2026-07-13",
          fetchedAt: new Date(Date.now() + 2 * 60 * 60 * 1_000).toISOString(),
        },
      ],
      requirements: [],
    });
    expect(
      (
        await db.pool.query<{ latest_version: string }>(
          `select latest_version
             from driver_catalog
            where vendor = 'nvidia' and os = 'windows' and component = 'gpu'`,
        )
      ).rows,
    ).toEqual([{ latest_version: "611.00" }]);
  });

  it("replaces legacy seed provenance when a verified source has an older release date", async () => {
    const { rows: games } = await db.pool.query<{ id: string }>(
      `insert into games (slug, name)
       values ('legacy-provenance-refresh-game', 'Legacy Provenance Refresh Game')
       returning id`,
    );
    const gameId = games[0]?.id;
    if (!gameId) throw new Error("failed to create legacy-provenance test game");

    await db.pool.query(
      `insert into game_driver_requirements (
         game_id, vendor, os, min_version, source_url, released_at, fetched_at
       ) values ($1, 'nvidia', 'windows', '566.36',
                 'repo://infra/db/migrations/0012_seed_required_drivers.sql',
                 '2026-07-13', '2026-07-13T00:00:00.000Z')`,
      [gameId],
    );
    const execute = async (text: string, params: readonly unknown[]) =>
      (await db.pool.query(text, [...params])).rows;

    const report = await persistCurationWith(execute, {
      catalog: [],
      requirements: [
        {
          vendor: "nvidia",
          os: "windows",
          minVersion: "566.36",
          title: "Legacy Provenance Refresh Game",
          releasedAt: "2024-12-05",
          sourceUrl: "https://www.nvidia.com/en-us/drivers/details/236599/",
          fetchedAt: "2026-07-20T00:00:00.000Z",
        },
      ],
    });

    expect(report).toMatchObject({ requirementsMatched: 1, requirementsUpserted: 1 });
    const stored = await db.pool.query<{
      min_version: string;
      source_url: string;
      released_at: string;
    }>(
      `select min_version, source_url, released_at::text as released_at
         from game_driver_requirements
        where game_id = $1 and vendor = 'nvidia' and os = 'windows'`,
      [gameId],
    );
    expect(stored.rows).toEqual([
      {
        min_version: "566.36",
        source_url: "https://www.nvidia.com/en-us/drivers/details/236599/",
        released_at: "2024-12-05",
      },
    ]);
  });

  it("keeps the highest same-day version after aliases resolve to one game", async () => {
    await db.pool.query(
      `insert into games (slug, name)
       values ('same-day-driver-version-alias-game-deluxe-edition',
               'Same Day Driver Version Alias Game Deluxe Edition')`,
    );
    const execute = async (text: string, params: readonly unknown[]) =>
      (await db.pool.query(text, [...params])).rows;
    const releasedAt = "2026-07-14";
    const fetchedAt = "2026-07-14T00:00:00.000Z";

    const first = await persistCurationWith(execute, {
      catalog: [
        {
          vendor: "nvidia",
          os: "windows",
          component: "gpu",
          gpuSeries: "same-day-alias-test",
          latestVersion: "611.00",
          releasedAt,
          sourceUrl: "https://www.nvidia.com/en-us/drivers/details/273100/",
          fetchedAt,
        },
      ],
      requirements: [
        {
          vendor: "nvidia",
          os: "windows",
          minVersion: "610.99",
          title: "Same Day Driver Version Alias Game Deluxe Edition",
          releasedAt,
          sourceUrl: "https://www.nvidia.com/en-us/drivers/details/273100/",
          fetchedAt,
        },
        {
          vendor: "nvidia",
          os: "windows",
          minVersion: "611.00",
          title: "Same Day Driver Version Alias Game Deluxe",
          releasedAt,
          sourceUrl: "https://www.nvidia.com/en-us/drivers/details/273100/",
          fetchedAt,
        },
      ],
    });
    expect(first).toMatchObject({ catalogUpserted: 1, requirementsMatched: 2, requirementsUpserted: 1 });
    await expectHighestDriverVersions(db);

    await persistCurationWith(execute, {
      catalog: [
        {
          vendor: "nvidia",
          os: "windows",
          component: "gpu",
          gpuSeries: "same-day-alias-test",
          latestVersion: "610.99",
          releasedAt,
          sourceUrl: "https://www.nvidia.com/en-us/drivers/details/273099/",
          fetchedAt: "2026-07-14T01:00:00.000Z",
        },
      ],
      requirements: [
        {
          vendor: "nvidia",
          os: "windows",
          minVersion: "610.99",
          title: "Same Day Driver Version Alias Game Deluxe Edition",
          releasedAt,
          sourceUrl: "https://www.nvidia.com/en-us/drivers/details/273099/",
          fetchedAt: "2026-07-14T01:00:00.000Z",
        },
      ],
    });
    await expectHighestDriverVersions(db);
  });
});

async function expectHighestDriverVersions(db: TestDb): Promise<void> {
  await expect(
    db.pool.query<{ latest_version: string }>(
      `select latest_version
         from driver_catalog
        where vendor = 'nvidia' and os = 'windows' and component = 'gpu'
          and gpu_series = 'same-day-alias-test'`,
    ),
  ).resolves.toMatchObject({ rows: [{ latest_version: "611.00" }] });
  await expect(
    db.pool.query<{ min_version: string }>(
      `select requirement.min_version
         from game_driver_requirements requirement
         join games g on g.id = requirement.game_id
        where g.slug = 'same-day-driver-version-alias-game-deluxe-edition'
          and requirement.vendor = 'nvidia' and requirement.os = 'windows'`,
    ),
  ).resolves.toMatchObject({ rows: [{ min_version: "611.00" }] });
}
