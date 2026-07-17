import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  aggregateEligibilitySql,
  GAME_SUBMISSIONS_PAGE_SIZE,
  RUN_STATUS,
  RUN_VISIBILITY,
  validRun,
} from "@heimdall/shared";
import type { MethodologyManifest, Run } from "@heimdall/shared";

import {
  DRIVER_CATALOG_MAX_AGE_DAYS,
  insertRun,
  REQUIRED_DRIVER_MAX_AGE_DAYS,
} from "../db";
import { createTestDb, testDbAvailable, type TestDb } from "../testing/test-db";
import { resolveGameId, resolveHardwareId } from "./catalog";
import { InvalidGameSubmissionsCursorError, readGamePage } from "./games";

const canRun = testDbAvailable("games.test");

const completeMethodology: MethodologyManifest = {
  version: 1,
  scene: "Dogtown benchmark",
  sceneType: "benchmark-scene",
  settingsPreset: "Ultra",
  graphicsApi: "dx12",
  resolution: "2560x1440",
  upscaler: "none",
  rayTracing: "off",
  frameGeneration: "none",
  framePacing: { vsync: false, vrr: false },
};

describe.skipIf(!canRun)("game discovery read (§17.7)", () => {
  let db: TestDb;
  let gameId: string;
  let otherGameId: string;
  const visibleIds = [
    "game_current_profiled",
    "game_warmup",
    "game_legacy",
    "game_set_member",
  ];

  beforeAll(async () => {
    db = await createTestDb();
    const [resolvedGameId, resolvedOtherGameId, gpuId, cpuId] = await Promise.all([
      resolveGameId("capframex", "Cyberpunk 2077", db.pool),
      resolveGameId("capframex", "Alan Wake 2", db.pool),
      resolveHardwareId(
        "gpu",
        "capframex",
        "NVIDIA GeForce RTX 4070",
        "nvidia",
        db.pool,
      ),
      resolveHardwareId("cpu", "capframex", "AMD Ryzen 7 7800X3D", "amd", db.pool),
    ]);
    if (!resolvedGameId || !resolvedOtherGameId || !gpuId || !cpuId) {
      throw new Error("expected canonical game-page fixtures");
    }
    gameId = resolvedGameId;
    otherGameId = resolvedOtherGameId;

    await db.pool.query(
      "insert into users (id, handle) values ('game_test_user', 'FrameHunter')",
    );

    const makeRun = (
      id: string,
      createdAt: string,
      overrides: Partial<Run> = {},
    ): Run => ({
      ...validRun,
      id,
      createdAt,
      framesObjectKey: `runs/${id}.parquet`,
      hardware: {
        ...validRun.hardware,
        canonicalGpuId: gpuId,
        canonicalCpuId: cpuId,
      },
      ...overrides,
    });

    const setId = "017f22e2-79b0-4f15-a3cb-a3e24f51f345";
    const fixtures: Array<{ run: Run; targetGameId: string; setSecret?: string }> = [
      {
        run: makeRun("game_current_profiled", "2026-07-15T12:04:00.000Z", {
          ownerId: "game_test_user",
          methodologyManifest: completeMethodology,
        }),
        targetGameId: gameId,
      },
      {
        run: makeRun("game_warmup", "2026-07-15T12:03:00.000Z", {
          methodologyManifest: { ...completeMethodology, sceneType: "gameplay" },
          isWarmup: true,
        }),
        targetGameId: gameId,
      },
      {
        run: makeRun("game_legacy", "2026-07-15T12:03:00.000Z"),
        targetGameId: gameId,
      },
      {
        run: makeRun("game_set_member", "2026-07-15T12:02:00.000Z", {
          methodologyManifest: { ...completeMethodology, sceneType: "freeform" },
          benchmarkSetId: setId,
        }),
        targetGameId: gameId,
        setSecret: "a".repeat(64),
      },
      {
        run: makeRun("game_unlisted", "2026-07-15T12:10:00.000Z", {
          visibility: RUN_VISIBILITY.unlisted,
        }),
        targetGameId: gameId,
      },
      {
        run: makeRun("game_pending", "2026-07-15T12:09:00.000Z", {
          status: RUN_STATUS.pending,
        }),
        targetGameId: gameId,
      },
      {
        run: makeRun("game_flagged", "2026-07-15T12:08:00.000Z", {
          status: RUN_STATUS.flagged,
        }),
        targetGameId: gameId,
      },
      {
        run: makeRun("game_other_title", "2026-07-15T12:11:00.000Z", {
          game: "Alan Wake 2",
        }),
        targetGameId: otherGameId,
      },
    ];

    for (const fixture of fixtures) {
      await insertRun(
        fixture.run,
        db.pool,
        fixture.setSecret ? { benchmarkSetSecretHash: fixture.setSecret } : {},
      );
      await db.pool.query("update runs set game_id = $2 where id = $1", [
        fixture.run.id,
        fixture.targetGameId,
      ]);
    }

    await db.pool.query(
      `insert into game_driver_requirements (
         game_id, vendor, os, min_version, source_url, released_at, fetched_at
       ) values ($1, 'nvidia', 'windows', '600.00', 'https://example.test/required',
                 current_date - interval '30 days', now())
       on conflict (game_id, vendor, os) do update
         set min_version = excluded.min_version,
             source_url = excluded.source_url,
             released_at = excluded.released_at,
             fetched_at = excluded.fetched_at`,
      [gameId],
    );
    await db.pool.query(
      `insert into driver_catalog (
         vendor, os, component, gpu_series, latest_version,
         released_at, source_url, fetched_at
       ) values ('nvidia', 'windows', 'gpu', null, '610.00',
                 current_date - interval '30 days', 'https://example.test/latest', now())
       on conflict (vendor, os, component, gpu_series_key) do update
         set latest_version = excluded.latest_version,
             released_at = excluded.released_at,
             source_url = excluded.source_url,
             fetched_at = excluded.fetched_at`,
    );
  }, 240_000);

  afterAll(async () => {
    await db?.teardown();
  });

  it("lists only public validated runs in deterministic recency order", async () => {
    const result = await readGamePage(
      "cyberpunk-2077",
      { limit: GAME_SUBMISSIONS_PAGE_SIZE },
      db.pool,
    );

    expect(result?.game).toEqual(
      expect.objectContaining({ slug: "cyberpunk-2077", name: "Cyberpunk 2077" }),
    );
    expect(result?.submissions.rows.map((row) => row.id)).toEqual(visibleIds);
    expect(result?.submissions.nextCursor).toBeNull();
    expect(result?.submissions.rows[0]).toEqual(
      expect.objectContaining({
        submittedBy: "FrameHunter",
        gpu: "NVIDIA GeForce RTX 4070",
        cpu: "AMD Ryzen 7 7800X3D",
        driverBelowMinimum: true,
        driverBehindLatest: true,
      }),
    );
    expect(result?.submissions.rows[0]?.methodology.profileComplete).toBe(true);
    expect(result?.submissions.rows[1]).toEqual(
      expect.objectContaining({ sceneType: "gameplay", isWarmup: true }),
    );
    expect(result?.submissions.rows[2]?.methodology.profileComplete).toBe(false);
    expect(result?.submissions.rows[3]).toEqual(
      expect.objectContaining({
        sceneType: "freeform",
        benchmarkSetId: "017f22e2-79b0-4f15-a3cb-a3e24f51f345",
      }),
    );

    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("anonymous_management_token_hash");
    expect(serialized).not.toContain("signature");
    expect(serialized).not.toContain("email");
  });

  it("keyset-paginates equal timestamps without duplicates", async () => {
    const first = await readGamePage("cyberpunk-2077", { limit: 2 }, db.pool);
    expect(first?.submissions.rows.map((row) => row.id)).toEqual(visibleIds.slice(0, 2));
    expect(first?.submissions.nextCursor).toEqual(expect.any(String));

    const second = await readGamePage(
      "cyberpunk-2077",
      { limit: 2, cursor: first?.submissions.nextCursor ?? undefined },
      db.pool,
    );
    expect(second?.submissions.rows.map((row) => row.id)).toEqual(visibleIds.slice(2));
    expect(second?.submissions.nextCursor).toBeNull();
    expect(
      new Set([...(first?.submissions.rows ?? []), ...(second?.submissions.rows ?? [])].map((r) => r.id))
        .size,
    ).toBe(visibleIds.length);
  });

  it("keyset-paginates oldest-first when the table recency direction is ascending", async () => {
    const expected = [...visibleIds].reverse();
    const first = await readGamePage(
      "cyberpunk-2077",
      { limit: 2, sortDirection: "asc" },
      db.pool,
    );
    expect(first?.submissions.rows.map((row) => row.id)).toEqual(expected.slice(0, 2));

    const second = await readGamePage(
      "cyberpunk-2077",
      {
        limit: 2,
        sortDirection: "asc",
        cursor: first?.submissions.nextCursor ?? undefined,
      },
      db.pool,
    );
    expect(second?.submissions.rows.map((row) => row.id)).toEqual(expected.slice(2));
    expect(second?.submissions.nextCursor).toBeNull();
  });

  it("filters individual rows by scene type", async () => {
    const result = await readGamePage(
      "cyberpunk-2077",
      { limit: GAME_SUBMISSIONS_PAGE_SIZE, sceneType: "gameplay" },
      db.pool,
    );
    expect(result?.submissions.rows.map((row) => row.id)).toEqual(["game_warmup"]);
  });

  it("uses the scene-aware recency index for selective submissions filters", async () => {
    const client = await db.pool.connect();
    try {
      await client.query("begin");
      await client.query("analyze runs");
      await client.query("set local enable_seqscan = off");
      const { rows } = await client.query<{ "QUERY PLAN": unknown }>(
        `explain (analyze, buffers, format json)
         select r.id
          from runs r
          where r.game_id = $1
            and ${aggregateEligibilitySql("r")}
            and r.scene_type = $2
          order by r.created_at desc, r.id desc
          limit $3`,
        [gameId, "gameplay", GAME_SUBMISSIONS_PAGE_SIZE],
      );
      const plan = JSON.stringify(rows[0]?.["QUERY PLAN"]);
      expect(plan).toContain("runs_game_scene_recent_idx");
    } finally {
      await client.query("rollback").catch(() => undefined);
      client.release();
    }
  });

  it("normalizes device-manager driver strings before flagging currency badges", async () => {
    // Regression: DriverBadges once compared the raw stored gpu_driver against
    // the curated marketing-form versions. A Windows Device-Manager string like
    // "32.0.16.2036" normalizes to marketing "620.36" — newer than both the
    // 600.00 minimum and the 610.00 latest — yet a raw segment compare
    // ([32,0,16,2036] < [600]) falsely reported "below minimum"/"outdated" on
    // essentially every NVIDIA/Windows submission. The server must normalize.
    const [normGameId, normGpuId, normCpuId] = await Promise.all([
      resolveGameId("capframex", "Driver Norm Sentinel", db.pool),
      resolveHardwareId("gpu", "capframex", "NVIDIA GeForce RTX 4080", "nvidia", db.pool),
      resolveHardwareId("cpu", "capframex", "AMD Ryzen 9 7950X3D", "amd", db.pool),
    ]);
    if (!normGameId || !normGpuId || !normCpuId) {
      throw new Error("expected driver-norm canonical fixtures");
    }

    const run: Run = {
      ...validRun,
      id: "game_devicemanager_driver",
      createdAt: "2026-07-15T13:00:00.000Z",
      framesObjectKey: "runs/game_devicemanager_driver.parquet",
      hardware: {
        ...validRun.hardware,
        canonicalGpuId: normGpuId,
        canonicalCpuId: normCpuId,
        gpuDriver: "32.0.16.2036",
      },
    };
    await insertRun(run, db.pool);
    await db.pool.query("update runs set game_id = $2 where id = $1", [run.id, normGameId]);
    // The nvidia/windows driver_catalog latest (610.00) is a global row already
    // seeded in beforeAll; only the per-game minimum needs adding here.
    await db.pool.query(
      `insert into game_driver_requirements (
         game_id, vendor, os, min_version, source_url, released_at, fetched_at
       ) values ($1, 'nvidia', 'windows', '600.00', 'https://example.test/required',
                 current_date - interval '30 days', now())`,
      [normGameId],
    );

    const page = await readGamePage("driver-norm-sentinel", { limit: 1 }, db.pool);
    expect(page?.submissions.rows[0]).toEqual(
      expect.objectContaining({
        id: "game_devicemanager_driver",
        driverBelowMinimum: false,
        driverBehindLatest: false,
      }),
    );
  });

  it("suppresses stale driver facts and restores them only after refresh", async () => {
    await db.pool.query(
      `update game_driver_requirements
          set fetched_at = now() - (($2 + 1)::integer * interval '1 day')
        where game_id = $1 and vendor = 'nvidia' and os = 'windows'`,
      [gameId, REQUIRED_DRIVER_MAX_AGE_DAYS],
    );
    await db.pool.query(
      `update driver_catalog
          set fetched_at = now() - (($1 + 1)::integer * interval '1 day')
        where vendor = 'nvidia' and os = 'windows' and component = 'gpu'`,
      [DRIVER_CATALOG_MAX_AGE_DAYS],
    );

    const stale = await readGamePage("cyberpunk-2077", { limit: 1 }, db.pool);
    expect(stale?.submissions.rows[0]).toEqual(
      expect.objectContaining({ driverBelowMinimum: false, driverBehindLatest: false }),
    );

    await db.pool.query(
      `update game_driver_requirements set fetched_at = now()
        where game_id = $1 and vendor = 'nvidia' and os = 'windows'`,
      [gameId],
    );
    await db.pool.query(
      `update driver_catalog set fetched_at = now()
        where vendor = 'nvidia' and os = 'windows' and component = 'gpu'`,
    );
    const fresh = await readGamePage("cyberpunk-2077", { limit: 1 }, db.pool);
    expect(fresh?.submissions.rows[0]).toEqual(
      expect.objectContaining({ driverBelowMinimum: true, driverBehindLatest: true }),
    );
  });

  it("returns null for an unknown game and rejects semantically invalid cursors", async () => {
    await expect(
      readGamePage("missing-game", { limit: GAME_SUBMISSIONS_PAGE_SIZE }, db.pool),
    ).resolves.toBeNull();
    await expect(
      readGamePage(
        "cyberpunk-2077",
        {
          limit: GAME_SUBMISSIONS_PAGE_SIZE,
          cursor: Buffer.from("not-a-date|run", "utf8").toString("base64url"),
        },
        db.pool,
      ),
    ).rejects.toBeInstanceOf(InvalidGameSubmissionsCursorError);
  });
});
