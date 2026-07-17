/** Phase 6.7 regression and scale coverage against real Postgres. */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import fc from "fast-check";
import { parquetWriteBuffer } from "hyparquet-writer";
import { DIAGNOSTIC_RULES, computeRunSummary, deriveCapabilityManifest } from "@heimdall/parsers";
import {
  CAPABILITY_MANIFEST_VERSION,
  COHORT_EXCLUSION,
  METHODOLOGY_MANIFEST_VERSION,
  RUN_STATUS,
  RUN_VISIBILITY,
  cohortEligibilitySql,
  cohortExclusionReasons,
  framesToColumnData,
  validFrames,
  validRun,
  type DiagnosticFinding,
  type MethodologyManifest,
  type Run,
} from "@heimdall/shared";
import { insertDiagnostics, insertRun, readDiagnostics, readRun } from "../db";
import {
  claimNextReprocessJob,
  completeReprocessJob,
  enqueueDriverRefreshJobs,
  enqueueFullReprocessJobs,
  failReprocessJob,
  FULL_REPROCESS_ENQUEUE_SQL,
  REPROCESS_KIND,
} from "../repo/reprocess";
import { finalizeRun } from "../repo/runs";
import { createTestDb, testDbAvailable, type TestDb } from "../testing/test-db";
import { drainReprocessJobs, runMaintenancePass } from "./drain";
import { verifyRunJob } from "./verify-run";

const canRun = testDbAvailable("reprocess.test");
const honestSummary = computeRunSummary(validFrames);
const parquetBytes = new Uint8Array(
  parquetWriteBuffer({ columnData: framesToColumnData(validFrames) }),
);

const methodology: MethodologyManifest = {
  version: METHODOLOGY_MANIFEST_VERSION,
  scene: "Dogtown loop",
  sceneType: "benchmark-scene",
  settingsPreset: "Ultra",
  graphicsApi: "dx12",
  resolution: "2560x1440",
  upscaler: "none",
  rayTracing: "off",
  frameGeneration: "none",
  framePacing: { vsync: false, vrr: true },
};

const hardware = {
  ...validRun.hardware,
  gpuVendor: "nvidia" as const,
  gpuDriver: "500.00",
  os: undefined,
};
const capability = deriveCapabilityManifest(validFrames, "capframex", hardware);

function runFixture(id: string, overrides: Partial<Run> = {}): Run {
  return {
    ...validRun,
    id,
    status: RUN_STATUS.validated,
    visibility: RUN_VISIBILITY.public,
    hardware,
    summary: honestSummary,
    framesObjectKey: `runs/${id}.parquet`,
    methodologyManifest: methodology,
    capabilityManifest: capability,
    ...overrides,
  };
}

describe.skipIf(!canRun)("Phase 6.7 data activation", () => {
  let db: TestDb;
  let gameId: string;
  let gpuId: string;
  const benchmarkSetId = "f3f24543-0b77-493f-b241-75f8633df5e0";

  beforeAll(async () => {
    db = await createTestDb();
    const game = await db.pool.query<{ id: string }>(
      `insert into games (slug, name) values ('phase-6-7-game', 'Phase 6.7 Game') returning id`,
    );
    gameId = game.rows[0]!.id;
    const gpu = await db.pool.query<{ id: string }>(
      `insert into hardware (kind, vendor, canonical_name)
       values ('gpu', 'nvidia', 'Phase 6.7 GPU') returning id`,
    );
    gpuId = gpu.rows[0]!.id;
    await db.pool.query(
      `insert into benchmark_sets (id, secret_hash) values ($1, 'phase-6-7-test')`,
      [benchmarkSetId],
    );
  }, 240_000);

  afterAll(async () => {
    await db?.teardown();
  });

  beforeEach(async () => {
    await db.pool.query("delete from runs");
    await db.pool.query("delete from reprocess_watermarks");
    await db.pool.query(
      `update driver_catalog
          set fetched_at = now(),
              released_at = current_date - 14,
              latest_version = case
                when vendor = 'nvidia' and os = 'windows' then '610.74'
                else latest_version
              end`,
    );
  });

  async function settleDriverWatermark(): Promise<void> {
    // Must mirror enqueueDriverRefreshJobs' watermark: both driver sources, or
    // the stored value never matches and every sweep re-requests.
    await db.pool.query(
      `insert into reprocess_watermarks (key, value, updated_at)
       select 'driver-catalog',
              greatest(
                (select max(fetched_at) from driver_catalog),
                (select max(fetched_at) from game_driver_requirements)
              ),
              now()
       on conflict (key) do update
         set value = excluded.value, updated_at = excluded.updated_at`,
    );
  }

  it("property: typed eligibility agrees with the SQL predicate", async () => {
    let sequence = 0;
    const inputArbitrary = fc.record({
      visibility: fc.constantFrom(
        RUN_VISIBILITY.private,
        RUN_VISIBILITY.unlisted,
        RUN_VISIBILITY.public,
      ),
      status: fc.constantFrom(
        RUN_STATUS.pending,
        RUN_STATUS.validated,
        RUN_STATUS.flagged,
        RUN_STATUS.hidden,
      ),
      gameResolved: fc.boolean(),
      gpuResolved: fc.boolean(),
      profileEstablished: fc.boolean(),
      capabilityEstablished: fc.boolean(),
      warmup: fc.boolean(),
      setMember: fc.boolean(),
    });

    await fc.assert(
      fc.asyncProperty(inputArbitrary, async (generated) => {
        const id = `run_eligibility_property_${sequence++}`;
        const run = runFixture(id, {
          visibility: generated.visibility,
          status: generated.status,
          methodologyManifest: generated.profileEstablished ? methodology : undefined,
          capabilityManifest: generated.capabilityEstablished ? capability : undefined,
          ...(generated.warmup ? { isWarmup: true } : {}),
        });
        await insertRun(run, db.pool);
        await db.pool.query(
          `update runs
              set game_id = $2::bigint,
                  gpu_hardware_id = $3::bigint,
                  benchmark_set_id = $4
            where id = $1`,
          [
            id,
            generated.gameResolved ? gameId : null,
            generated.gpuResolved ? gpuId : null,
            generated.setMember ? benchmarkSetId : null,
          ],
        );
        const pureEligible =
          cohortExclusionReasons({
            visibility: generated.visibility,
            status: generated.status,
            gameId: generated.gameResolved ? gameId : null,
            gpuId: generated.gpuResolved ? gpuId : null,
            methodologyManifest: generated.profileEstablished ? methodology : undefined,
            methodologyManifestVersion: generated.profileEstablished
              ? METHODOLOGY_MANIFEST_VERSION
              : null,
            capabilityManifestVersion: generated.capabilityEstablished
              ? CAPABILITY_MANIFEST_VERSION
              : null,
            isWarmup: generated.warmup,
            benchmarkSetId: generated.setMember ? benchmarkSetId : null,
          }).length === 0;
        const sql = await db.pool.query<{ eligible: boolean }>(
          `select ${cohortEligibilitySql("r")} as eligible from runs r where id = $1`,
          [id],
        );
        expect(sql.rows[0]?.eligible).toBe(pureEligible);
        await db.pool.query("delete from runs where id = $1", [id]);
      }),
      { numRuns: 40, seed: 0x67a11b1e },
    );
  });

  it("enriches an old Parquet run without changing status or inventing methodology", async () => {
    const id = "run_reprocess_status_preserved";
    await insertRun(
      runFixture(id, {
        summary: { ...honestSummary, avgFps: honestSummary.avgFps + 25 },
        capabilityManifest: undefined,
        methodologyManifest: undefined,
      }),
      db.pool,
    );
    await db.pool.query("update runs set signature_valid = true where id = $1", [id]);
    await settleDriverWatermark();
    expect(await enqueueFullReprocessJobs({}, db.pool)).toBe(1);

    let objectReads = 0;
    const result = await drainReprocessJobs(
      { maxJobs: 1 },
      {
        db: db.pool,
        getObject: async () => {
          objectReads += 1;
          return parquetBytes;
        },
      },
    );
    expect(result).toMatchObject({ reprocessed: 1, reprocessSummaryDrifted: 1 });
    expect(objectReads).toBe(1);

    const run = await readRun(id, db.pool);
    expect(run?.status).toBe(RUN_STATUS.validated);
    expect(run?.summary).toEqual(honestSummary);
    expect(run?.capabilityManifest?.version).toBe(CAPABILITY_MANIFEST_VERSION);
    expect(run?.methodologyManifest).toBeUndefined();
    const signature = await db.pool.query<{ signature_valid: boolean | null }>(
      "select signature_valid from runs where id = $1",
      [id],
    );
    expect(signature.rows[0]?.signature_valid).toBe(true);
    expect(
      cohortExclusionReasons({
        visibility: run!.visibility,
        status: run!.status,
        gameId: null,
        gpuId: null,
        methodologyManifest: run!.methodologyManifest,
        methodologyManifestVersion: null,
        capabilityManifestVersion: run!.capabilityManifest?.version ?? null,
        isWarmup: false,
        benchmarkSetId: null,
      }),
    ).toContain(COHORT_EXCLUSION.unprofiled);
  });

  it("refreshes driver findings without R2, preserves other findings, and ages to none", async () => {
    const id = "run_driver_refresh";
    await insertRun(runFixture(id), db.pool);
    await insertDiagnostics(
      id,
      [
        {
          code: "cpu-bottleneck",
          severity: "warn",
          title: "CPU pressure",
          detail: "Non-driver finding must survive.",
          ruleVersion: "1.0.0",
        },
      ],
      db.pool,
    );

    const first = await drainReprocessJobs(
      { maxJobs: 1 },
      {
        db: db.pool,
        getObject: async () => {
          throw new Error("driver refresh must not read R2");
        },
      },
    );
    expect(first).toMatchObject({ driverRefreshed: 1, driverFindingsChanged: 1 });
    let findings = await readDiagnostics(id, db.pool);
    expect(findings.map((finding) => finding.code)).toEqual([
      "cpu-bottleneck",
      "driver-update-available",
    ]);
    expect(findings[1]?.evidence?.provenance).toMatchObject({
      latestVersion: "610.74",
    });
    expect(findings[1]?.ruleVersion).toBe("1.1.0");

    const beforeNoop = await db.pool.query<{
      diagnostic_id: string;
      diagnostic_evaluated_at: Date;
      driver_evaluated_at: Date;
    }>(
      `select d.id as diagnostic_id,
              d.evaluated_at as diagnostic_evaluated_at,
              r.driver_evaluated_at
         from diagnostics d
         join runs r on r.id = d.run_id
        where d.run_id = $1 and d.code = 'driver-update-available'`,
      [id],
    );
    await db.pool.query(
      `update driver_catalog
          set fetched_at = now() + interval '1 second'
        where vendor = 'nvidia' and os = 'windows' and component = 'gpu'`,
    );
    expect((await enqueueDriverRefreshJobs({}, db.pool)).enqueued).toBe(1);
    const noOp = await claimNextReprocessJob(REPROCESS_KIND.driver, {}, db.pool);
    expect(noOp).not.toBeNull();
    const noOpResult = await import("./reprocess-run").then(({ refreshDriverFindingsJob }) =>
      refreshDriverFindingsJob(noOp!, db.pool),
    );
    expect(noOpResult).toEqual({ kind: "refreshed", changed: false });
    await completeReprocessJob(noOp!, db.pool);
    const afterNoop = await db.pool.query<{
      diagnostic_id: string;
      diagnostic_evaluated_at: Date;
      driver_evaluated_at: Date;
    }>(
      `select d.id as diagnostic_id,
              d.evaluated_at as diagnostic_evaluated_at,
              r.driver_evaluated_at
         from diagnostics d
         join runs r on r.id = d.run_id
        where d.run_id = $1 and d.code = 'driver-update-available'`,
      [id],
    );
    expect(afterNoop.rows[0]?.diagnostic_id).toBe(beforeNoop.rows[0]?.diagnostic_id);
    expect(afterNoop.rows[0]?.diagnostic_evaluated_at).toEqual(
      beforeNoop.rows[0]?.diagnostic_evaluated_at,
    );
    expect(afterNoop.rows[0]?.driver_evaluated_at.getTime()).toBeGreaterThanOrEqual(
      beforeNoop.rows[0]!.driver_evaluated_at.getTime(),
    );

    const unchanged = await enqueueDriverRefreshJobs({}, db.pool);
    expect(unchanged).toEqual({ enqueued: 0, sweepRequested: false, sweepComplete: true });

    await db.pool.query(
      `update driver_catalog
          set latest_version = '611.00', fetched_at = now() + interval '2 seconds'
        where vendor = 'nvidia' and os = 'windows' and component = 'gpu'`,
    );
    expect((await enqueueDriverRefreshJobs({}, db.pool)).enqueued).toBe(1);
    const moved = await claimNextReprocessJob(REPROCESS_KIND.driver, {}, db.pool);
    expect(moved).not.toBeNull();
    const movedResult = await import("./reprocess-run").then(({ refreshDriverFindingsJob }) =>
      refreshDriverFindingsJob(moved!, db.pool),
    );
    expect(movedResult).toEqual({ kind: "refreshed", changed: true });
    await completeReprocessJob(moved!, db.pool);
    findings = await readDiagnostics(id, db.pool);
    expect(findings.find((finding) => finding.code === "driver-update-available")?.detail).toContain(
      "611.00",
    );

    await db.pool.query(
      `update driver_catalog
          set fetched_at = now() - interval '31 days'
        where vendor = 'nvidia' and os = 'windows' and component = 'gpu'`,
    );
    expect((await enqueueDriverRefreshJobs({}, db.pool)).enqueued).toBe(1);
    const expired = await claimNextReprocessJob(REPROCESS_KIND.driver, {}, db.pool);
    expect(expired).not.toBeNull();
    const expiredResult = await import("./reprocess-run").then(({ refreshDriverFindingsJob }) =>
      refreshDriverFindingsJob(expired!, db.pool),
    );
    expect(expiredResult).toEqual({ kind: "refreshed", changed: true });
    await completeReprocessJob(expired!, db.pool);
    expect((await readDiagnostics(id, db.pool)).map((finding) => finding.code)).toEqual([
      "cpu-bottleneck",
    ]);
  });

  it("keeps a terminal failure as a tombstone and enqueue remains idempotent", async () => {
    const id = "run_reprocess_tombstone";
    await insertRun(runFixture(id, { capabilityManifest: undefined }), db.pool);
    await settleDriverWatermark();
    expect(await enqueueFullReprocessJobs({}, db.pool)).toBe(1);
    expect(await enqueueFullReprocessJobs({}, db.pool)).toBe(0);
    const job = await claimNextReprocessJob(REPROCESS_KIND.full, {}, db.pool);
    expect(job).not.toBeNull();
    await failReprocessJob(job!, "unreadable legacy object", true, db.pool);
    expect(await enqueueFullReprocessJobs({}, db.pool)).toBe(0);
    const tombstone = await db.pool.query<{ failed_at: Date | null }>(
      "select failed_at from reprocess_jobs where run_id = $1 and kind = 'full'",
      [id],
    );
    expect(tombstone.rows[0]?.failed_at).toBeInstanceOf(Date);
  });

  it("never enumerates a pending run, so verification still compares client vs server", async () => {
    const pending = "run_reprocess_pending";
    // A pending run is the exact shape the backfill targets — legacy capability
    // manifest, stored Parquet — but its run_summaries row still holds the
    // CLIENT's numbers, and verifyRunJob decides validated/flagged by comparing
    // them against the server recompute. Reprocessing it first would overwrite
    // that row with the server value, making the comparison server-vs-server and
    // laundering a tampered upload to validated.
    await insertRun(
      runFixture(pending, { capabilityManifest: undefined, status: RUN_STATUS.pending }),
      db.pool,
    );
    await settleDriverWatermark();
    expect(await enqueueFullReprocessJobs({}, db.pool)).toBe(0);

    // The same run becomes eligible the moment it carries a verdict.
    await db.pool.query("update runs set status = 'validated' where id = $1", [pending]);
    expect(await enqueueFullReprocessJobs({}, db.pool)).toBe(1);
  });

  it("keeps findings in registry order after a driver refresh replaces them", async () => {
    const id = "run_driver_finding_order";
    await insertRun(runFixture(id), db.pool);
    await insertDiagnostics(
      id,
      [
        { code: "vram-saturation", severity: "warn", title: "VRAM", detail: "d" },
        { code: "driver-update-available", severity: "info", title: "Driver", detail: "d" },
        { code: "likely-gpu-bound", severity: "info", title: "GPU", detail: "d" },
      ] as unknown as DiagnosticFinding[],
      db.pool,
    );
    const registryOrder = (await readDiagnostics(id, db.pool)).map((row) => row.code);

    // Replacing the driver findings gives them fresh, higher serial ids. Reading
    // back by id would sort them below every other finding.
    await db.pool.query("delete from diagnostics where run_id = $1 and code = $2", [
      id,
      "driver-update-available",
    ]);
    await insertDiagnostics(
      id,
      [
        { code: "driver-update-available", severity: "info", title: "Driver", detail: "d2" },
      ] as unknown as DiagnosticFinding[],
      db.pool,
    );

    expect((await readDiagnostics(id, db.pool)).map((row) => row.code)).toEqual(registryOrder);
  });

  it("records driver_evaluated_at when the full lane replays the driver rules", async () => {
    const id = "run_full_sets_driver_watermark";
    await insertRun(runFixture(id, { capabilityManifest: undefined }), db.pool);
    await settleDriverWatermark();
    await db.pool.query("update runs set driver_evaluated_at = null where id = $1", [id]);
    expect(await enqueueFullReprocessJobs({}, db.pool)).toBe(1);
    await drainReprocessJobs(
      { maxJobs: 5 },
      { db: db.pool, getObject: async () => parquetBytes },
    );

    // DIAGNOSTIC_RULES includes both driver rules, so the replay re-evaluated
    // them; without recording that, the driver sweep re-queues the same work.
    const row = await db.pool.query<{ driver_evaluated_at: Date | null }>(
      "select driver_evaluated_at from runs where id = $1",
      [id],
    );
    expect(row.rows[0]?.driver_evaluated_at).toBeInstanceOf(Date);
  });

  it("revives a driver tombstone when a source watermark moves again", async () => {
    const id = "run_driver_tombstone_revive";
    await insertRun(runFixture(id), db.pool);
    await settleDriverWatermark();
    await db.pool.query(
      "update driver_catalog set fetched_at = now() + interval '1 hour', released_at = current_date",
    );
    expect((await enqueueDriverRefreshJobs({}, db.pool)).enqueued).toBe(1);

    // Exhaust the attempts on transient errors: the row tombstones, and
    // claimNextReprocessJob will never hand it out again.
    const job = await claimNextReprocessJob(REPROCESS_KIND.driver, {}, db.pool);
    await failReprocessJob(job!, "transient database hiccup", true, db.pool);
    await settleDriverWatermark();
    expect((await enqueueDriverRefreshJobs({}, db.pool)).enqueued).toBe(0);

    // A later catalog refresh is genuinely new evidence — the frozen run must
    // come back rather than stay excluded forever.
    await db.pool.query(
      "update driver_catalog set fetched_at = now() + interval '2 hours', released_at = current_date",
    );
    expect((await enqueueDriverRefreshJobs({}, db.pool)).enqueued).toBe(1);
    const revived = await claimNextReprocessJob(REPROCESS_KIND.driver, {}, db.pool);
    expect(revived?.runId).toBe(id);
  });

  it("sweeps driver findings from game_driver_requirements with an empty catalog", async () => {
    const id = "run_driver_requirements_only";
    await insertRun(runFixture(id), db.pool);
    await settleDriverWatermark();
    // gpuDriverOutdatedRule reads game_driver_requirements and needs no catalog
    // at all. Watermarking only driver_catalog left an empty catalog blocking
    // every driver refresh, including this one.
    await db.pool.query("delete from driver_catalog");
    await db.pool.query(
      "update game_driver_requirements set fetched_at = now() + interval '1 hour'",
    );
    const sweep = await enqueueDriverRefreshJobs({}, db.pool);
    expect(sweep.sweepRequested).toBe(true);
    expect(sweep.enqueued).toBe(1);
  });

  it("reclaims an interrupted full job without duplicate diagnostics", async () => {
    const id = "run_reprocess_restart";
    await insertRun(runFixture(id, { capabilityManifest: undefined }), db.pool);
    await settleDriverWatermark();
    await enqueueFullReprocessJobs({}, db.pool);
    const first = await claimNextReprocessJob(REPROCESS_KIND.full, {}, db.pool);
    expect(first).not.toBeNull();
    const deps = { db: db.pool, getObject: async () => parquetBytes };
    expect(await verifyRunJob(first!, deps, { mode: "reprocess" })).toMatchObject({
      kind: "reprocessed",
    });

    await db.pool.query(
      `update reprocess_jobs set not_before = now() - interval '1 minute'
        where run_id = $1 and kind = 'full'`,
      [id],
    );
    const reclaimed = await claimNextReprocessJob(REPROCESS_KIND.full, {}, db.pool);
    expect(reclaimed?.attempts).toBe(2);
    expect(await verifyRunJob(reclaimed!, deps, { mode: "reprocess" })).toMatchObject({
      kind: "reprocessed",
    });
    await completeReprocessJob(reclaimed!, db.pool);

    const counts = await db.pool.query<{ total: number | string; distinct_codes: number | string }>(
      `select count(*) as total, count(distinct code) as distinct_codes
         from diagnostics where run_id = $1`,
      [id],
    );
    expect(Number(counts.rows[0]?.total)).toBeGreaterThan(0);
    expect(Number(counts.rows[0]?.total)).toBe(Number(counts.rows[0]?.distinct_codes));
  });

  it("keeps live verification moving with a large full backfill queued", async () => {
    const liveId = "run_live_ingest_during_backfill";
    await insertRun(
      runFixture(liveId, {
        status: RUN_STATUS.pending,
        visibility: RUN_VISIBILITY.unlisted,
        framesObjectKey: undefined,
        capabilityManifest: undefined,
      }),
      db.pool,
    );
    expect(
      await finalizeRun(
        {
          id: liveId,
          framesObjectKey: `runs/${liveId}.parquet`,
          stagingCleanup: {
            objectKey: `uploads/${liveId}.parquet`,
            notBefore: new Date(Date.now() + 60 * 60_000),
          },
          visibility: RUN_VISIBILITY.unlisted,
          managementTokenHash: null,
          signature: null,
          gameId: null,
          gpuHardwareId: null,
          cpuHardwareId: null,
        },
        db.pool,
      ),
    ).toBe(true);
    await db.pool.query(
      `insert into runs (
         id, game_raw, capture_source, visibility, status,
         cpu_model, gpu_model, frames_object_key, schema_version, parser_version
       )
       select 'run_queued_backfill_' || value,
              'Backfill Game', 'capframex', 'unlisted', 'validated',
              'Backfill CPU', 'Backfill GPU',
              'runs/backfill-' || value || '.parquet', 1, 'legacy'
         from generate_series(1, 100) value`,
    );
    await db.pool.query(
      `insert into reprocess_jobs (run_id, kind)
       select id, 'full' from runs where id like 'run_queued_backfill_%'`,
    );
    await settleDriverWatermark();

    const result = await runMaintenancePass(
      { maxJobs: 1, budgetMs: 25_000 },
      {
        db: db.pool,
        getObject: async () => parquetBytes,
        deleteObject: async () => {},
      },
    );
    expect(result).toMatchObject({ claimed: 1, validated: 1, reprocessClaimed: 2 });
    const activeBackfill = await db.pool.query<{ count: number | string }>(
      `select count(*) from reprocess_jobs
        where kind = 'full' and failed_at is null`,
    );
    expect(Number(activeBackfill.rows[0]?.count)).toBe(98);
  });

  it("uses the reprocess sweep indexes on a production-shaped table", async () => {
    await db.pool.query(
      `insert into runs (
         id, game_raw, capture_source, visibility, status,
         cpu_model, gpu_model, gpu_vendor, gpu_driver,
         frames_object_key, schema_version, parser_version,
         capability_manifest_version, driver_evaluated_at
       )
       select 'run_scale_' || value,
              'Scale Game', 'capframex', 'public', 'validated',
              'Scale CPU', 'Scale GPU', 'nvidia', '500.00',
              'runs/scale-' || value || '.parquet', 1, 'scale',
              case when value % 2 = 0 then null else $1::integer end,
              case when value % 3 = 0 then null else now() end
         from generate_series(1, 5000) value`,
      [CAPABILITY_MANIFEST_VERSION],
    );
    const client = await db.pool.connect();
    try {
      await client.query("analyze runs");
      await client.query("begin");
      await client.query("set local enable_seqscan = off");
      const full = await client.query(
        `explain (analyze, buffers, format json) ${FULL_REPROCESS_ENQUEUE_SQL}`,
        [
          100,
          DIAGNOSTIC_RULES.map((rule) => rule.code),
          DIAGNOSTIC_RULES.map((rule) => rule.version),
          CAPABILITY_MANIFEST_VERSION,
        ],
      );
      const driver = await client.query(
        `explain (analyze, buffers, format json)
         select id from runs
          where status <> 'hidden'
            and (driver_evaluated_at is null or driver_evaluated_at < now())
          order by driver_evaluated_at nulls first, id
          limit 100`,
      );
      expect(JSON.stringify(full.rows)).toContain("runs_reprocess_capability_idx");
      expect(JSON.stringify(driver.rows)).toContain("runs_driver_evaluated_at_idx");
      await client.query("rollback");
    } finally {
      client.release();
    }
  });
});
