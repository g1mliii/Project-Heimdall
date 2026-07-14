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
      requirementsUpserted: 2,
      requirementsReceived: 4,
      requirementsMatched: 3,
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
          and g.name in ('Cyberpunk 2077', 'Tom Clancy Rainbow Six Siege Deluxe Edition')
        order by g.name`,
    );
    expect(requirements.rows).toEqual([
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
});
