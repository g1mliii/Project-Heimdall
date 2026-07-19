import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  COHORT_ASSESSMENT_VERSION,
  cohortObservationsSql,
  comparabilityKeySql,
  validRun,
  validSummary,
} from "@heimdall/shared";
import type { MethodologyManifest, Run } from "@heimdall/shared";

import { insertRun } from "../db";
import { createTestDb, testDbAvailable, type TestDb } from "../testing/test-db";
import { resolveGameId, resolveHardwareId } from "./catalog";
import { readGamePage } from "./games";
import { readGameDistribution } from "./distribution";
import {
  claimNextCohortAssessmentJob,
  completeCohortAssessmentJob,
  enqueueStaleCohortAssessments,
  failCohortAssessmentJob,
  readCohortAssessment,
  recomputeGameCohortAssessments,
} from "../integrity/cohort-assessment";

const canRun = testDbAvailable("distribution.db.test");

const methodology1440: MethodologyManifest = {
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
// Differ by preset (not resolution): normalizeMethodologyManifest reconciles a
// run's resolution with its hardware snapshot, so a resolution-only difference
// would collapse back into the hardware's bucket. Preset is not reconciled.
const methodologySet: MethodologyManifest = { ...methodology1440, settingsPreset: "High" };

const OUTLIER_ID = "dist_outlier";
const NORMAL_ID = "dist_normal_00";
const SET_ID = "017f22e2-79b0-4f15-a3cb-a3e24f51f345";
const SET_SECRET = "b".repeat(64);

describe.skipIf(!canRun)("cohort distribution + integrity (§17/§18/§19)", () => {
  let db: TestDb;
  let gameId: string;

  beforeAll(async () => {
    db = await createTestDb();
    const [resolvedGameId, gpuId, cpuId] = await Promise.all([
      resolveGameId("capframex", "Cyberpunk 2077", db.pool),
      resolveHardwareId("gpu", "capframex", "NVIDIA GeForce RTX 4070", "nvidia", db.pool),
      resolveHardwareId("cpu", "capframex", "AMD Ryzen 7 7800X3D", "amd", db.pool),
    ]);
    if (!resolvedGameId || !gpuId || !cpuId) throw new Error("expected canonical fixtures");
    gameId = resolvedGameId;

    const makeRun = (id: string, avgFps: number, overrides: Partial<Run> = {}): Run => ({
      ...validRun,
      id,
      createdAt: "2026-07-15T12:00:00.000Z",
      framesObjectKey: `runs/${id}.parquet`,
      summary: { ...validSummary, avgFps },
      methodologyManifest: methodology1440,
      hardware: { ...validRun.hardware, canonicalGpuId: gpuId, canonicalCpuId: cpuId },
      ...overrides,
    });

    // Bucket A (1440p): 31 tightly-clustered runs + one extreme outlier → 32
    // independent observations, enough for a curve.
    const seeds: { run: Run; secret?: string }[] = [];
    for (let i = 0; i < 31; i++) {
      seeds.push({ run: makeRun(`dist_normal_${String(i).padStart(2, "0")}`, 100 + i) });
    }
    seeds.push({ run: makeRun(OUTLIER_ID, 400) });

    // Bucket B (High preset): a three-pass benchmark set → ONE representative.
    for (let i = 0; i < 3; i++) {
      seeds.push({
        run: makeRun(`dist_set_${i}`, 110 + i * 5, {
          methodologyManifest: methodologySet,
          benchmarkSetId: SET_ID,
        }),
        secret: SET_SECRET,
      });
    }

    for (const seed of seeds) {
      await insertRun(seed.run, db.pool, seed.secret ? { benchmarkSetSecretHash: seed.secret } : {});
      await db.pool.query(
        `update runs
            set game_id = $2, capability_manifest_version = 1,
                diagnostics_rule_generation = 1, diagnostics_evaluated_at = now()
          where id = $1`,
        [seed.run.id, gameId],
      );
    }
  }, 240_000);

  afterAll(async () => {
    await db?.teardown();
  });

  it("pools an exact bucket into a curve with the outlier excluded but not hidden", async () => {
    const result = await readGameDistribution(
      "cyberpunk-2077",
      { metric: "avg-fps", viewerRunId: OUTLIER_ID },
      db.pool,
    );
    const bucketA = result?.cohorts.find(
      (cohort) => cohort.comparability.settingsPreset === "Ultra",
    );

    expect(bucketA?.observationCount).toBe(32);
    expect(bucketA?.distribution).not.toBeNull();
    // The lone 400 fps run is dropped from the curve...
    expect(bucketA?.excludedOutlierCount).toBe(1);
    expect(bucketA?.distribution?.sampleCount).toBe(31);
    expect(bucketA?.distribution?.max).toBeLessThan(200);
    // ...yet still counts and is placed at the top of the crowd as the viewer.
    expect(bucketA?.viewerValue).toBe(400);
    expect(bucketA?.viewerPercentile).toBe(100);

    // Never hidden: the outlier's run stays in the individual submissions list.
    const page = await readGamePage("cyberpunk-2077", { limit: 50 }, db.pool);
    const outlierRow = page?.submissions.rows.find((row) => row.id === OUTLIER_ID);
    expect(outlierRow).toBeDefined();
    expect(outlierRow?.avgFps).toBe(400);
  });

  it("counts a repeated benchmark set as one observation, below cold start", async () => {
    const result = await readGameDistribution("cyberpunk-2077", { metric: "avg-fps" }, db.pool);
    const bucketB = result?.cohorts.find(
      (cohort) => cohort.comparability.settingsPreset === "High",
    );
    expect(bucketB?.observationCount).toBe(1);
    expect(bucketB?.rawRunCount).toBe(3);
    expect(bucketB?.distribution).toBeNull();
    expect(bucketB?.excludedOutlierCount).toBe(0);

    // Game-level honesty: 35 eligible runs → 33 pooled observations (set folds).
    expect(result?.exclusionSummary.pooledObservations).toBe(33);
    expect(result?.exclusionSummary.aggregateEligibleRuns).toBe(35);

    // §17.8/§19.3: runs are evaluated at the current generation but carry no
    // sensors. The driver rate (no telemetry needed) reads 0% — "evaluated, did
    // not fire" — while every sensor-derived rate reports an unavailable
    // denominator, never a misleading clean 0%.
    const driver = result?.diagnosticRates.find((r) => r.key === "driver-currency");
    const vram = result?.diagnosticRates.find((r) => r.key === "vram-pressure");
    const cpu = result?.diagnosticRates.find((r) => r.key === "cpu-bound");
    expect(driver?.denominator).toBe(33);
    expect(driver?.ratePct).toBe(0);
    expect(vram?.denominator).toBe(0);
    expect(vram?.ratePct).toBeNull();
    expect(cpu?.denominator).toBe(0);
    expect(cpu?.ratePct).toBeNull();
  });

  it("persists a versioned outlier verdict without changing visibility", async () => {
    const summary = await recomputeGameCohortAssessments(gameId, db.pool);
    expect(summary.assessed).toBe(33); // 32 individuals + 1 set representative
    expect(summary.excluded).toBe(1);

    const outlier = await readCohortAssessment(OUTLIER_ID, db.pool);
    expect(outlier?.exclusionReason).toBe("statistical-outlier");
    expect(outlier?.assessmentVersion).toBe(1);

    const normal = await readCohortAssessment(NORMAL_ID, db.pool);
    expect(normal?.exclusionReason).toBeNull();

    // The run's lifecycle status is untouched by the assessment.
    const rows = await db.pool.query<{ status: string }>("select status from runs where id = $1", [
      OUTLIER_ID,
    ]);
    expect(rows.rows[0]?.status).toBe("validated");
  });

  it("enqueues, recomputes, and converges the assessment lane (§18.5)", async () => {
    // A fresh game with three unassessed eligible observations.
    const game = await db.pool.query<{ id: string }>(
      "insert into games (slug, name) values ('queue-title', 'Queue Title') returning id",
    );
    const queueGameId = game.rows[0]!.id;
    const gpuRow = await db.pool.query<{ id: string }>(
      "insert into hardware (kind, vendor, canonical_name) values ('gpu', 'nvidia', 'Queue GPU') returning id",
    );
    const queueGpuId = gpuRow.rows[0]!.id;
    await db.pool.query(
      `with inserted as (
         insert into runs (
           id, game_raw, game_id, capture_source, visibility, status,
           cpu_model, gpu_model, gpu_vendor, gpu_hardware_id,
           resolution, scene, settings_preset, upscaler, ray_tracing,
           generated_frame_tech, graphics_api, scene_type, vsync, vrr,
           methodology_manifest_version, capability_manifest_version,
           diagnostics_rule_generation, frames_object_key, schema_version,
           parser_version, is_warmup, created_at
         )
         select 'queue_' || value, 'Queue Title', $1, 'capframex', 'public', 'validated',
                'C', 'G', 'nvidia', $2, '2560x1440', 'S', 'Ultra', 'none', 'off',
                'none', 'dx12', 'benchmark-scene', false, false, 1, 1, 1,
                'runs/queue-' || value || '.parquet', 1, 'p', false, now()
           from generate_series(1, 3) value
         returning id
       )
       insert into run_summaries (
         run_id, avg_fps, p1_low_fps, p01_low_fps, frametime_p50_ms,
         frametime_p95_ms, frametime_p99_ms, stutter_count, generated_frame_pct,
         p01_low_confidence, sample_count, duration_seconds
       )
       select id, 120, 90, 80, 8, 10, 12, 0, 0, 'high', 7200, 60 from inserted`,
      [queueGameId, queueGpuId],
    );

    const queuedFor = async (id: string) =>
      (await db.pool.query("select 1 from cohort_assessment_jobs where game_id = $1", [id])).rowCount;

    // The bounded first sweep finds the stale game; recompute + complete clears it.
    await enqueueStaleCohortAssessments({}, db.pool);
    expect(await queuedFor(queueGameId)).toBe(1);

    let drained = 0;
    for (let job = await claimNextCohortAssessmentJob({}, db.pool); job; ) {
      await recomputeGameCohortAssessments(job.gameId, db.pool);
      await completeCohortAssessmentJob(job, db.pool);
      drained += 1;
      job = await claimNextCohortAssessmentJob({}, db.pool);
    }
    expect(drained).toBeGreaterThanOrEqual(1);

    const assessed = await readCohortAssessment("queue_1", db.pool);
    expect(assessed?.assessmentVersion).toBe(1);

    // Subsequent run/summary mutations enqueue only this game immediately,
    // without requiring the cursor sweep to revisit the whole catalog.
    await db.pool.query("update run_summaries set avg_fps = 121 where run_id = 'queue_1'");
    expect(await queuedFor(queueGameId)).toBe(1);
    const changed = await claimNextCohortAssessmentJob({}, db.pool);
    expect(changed?.gameId).toBe(queueGameId);
    await recomputeGameCohortAssessments(changed!.gameId, db.pool);
    await completeCohortAssessmentJob(changed!, db.pool);

    // Converged: re-enqueuing finds nothing new for this game.
    await enqueueStaleCohortAssessments({}, db.pool);
    expect(await queuedFor(queueGameId)).toBe(0);

    // A terminally failed game is quarantined: it stays queued as a tombstone
    // but is never claimed again, so it cannot consume a slot on every pass.
    await db.pool.query(
      `insert into cohort_assessment_jobs (game_id, attempts, locked_at)
       values ($1, 1, now())`,
      [queueGameId],
    );
    const claimed = await claimNextCohortAssessmentJob({}, db.pool);
    expect(claimed?.gameId).toBe(queueGameId);
    // The claim increments attempts — that is what makes a retry cap possible.
    expect(claimed?.attempts).toBe(2);

    await failCohortAssessmentJob(claimed!, "boom", true, db.pool);
    const tombstone = await db.pool.query<{ failed_assessment_version: number }>(
      "select failed_assessment_version from cohort_assessment_jobs where game_id = $1",
      [queueGameId],
    );
    expect(tombstone.rows[0]?.failed_assessment_version).toBe(COHORT_ASSESSMENT_VERSION);
    expect(await claimNextCohortAssessmentJob({}, db.pool)).toBeNull();

    // And the enqueue does NOT revive it at the same assessment version —
    // otherwise the quarantine would last exactly one pass.
    await enqueueStaleCohortAssessments({}, db.pool);
    expect(await claimNextCohortAssessmentJob({}, db.pool)).toBeNull();

    // Simulate a rule-generation bump. Resetting the versioned scan cursor lets
    // the new rules revisit this game once, and only a newer rule can revive a
    // terminal tombstone.
    await db.pool.query(
      "update cohort_assessment_jobs set failed_assessment_version = $1 where game_id = $2",
      [COHORT_ASSESSMENT_VERSION - 1, queueGameId],
    );
    await db.pool.query(
      "update cohort_assessment_scan_state set assessment_version = 0, last_game_id = 0 where singleton = true",
    );
    await db.pool.query("delete from run_cohort_assessments where run_id like 'queue_%'");
    await enqueueStaleCohortAssessments({}, db.pool);
    const revived = await db.pool.query<{
      attempts: number;
      failed_at: Date | null;
      failed_assessment_version: number | null;
    }>(
      `select attempts, failed_at, failed_assessment_version
         from cohort_assessment_jobs where game_id = $1`,
      [queueGameId],
    );
    expect(revived.rows).toEqual([
      { attempts: 0, failed_at: null, failed_assessment_version: null },
    ]);
  });

  it("keeps the cohort observation query index-backed on a larger cohort (§19.5)", async () => {
    // A fresh game with a few hundred eligible runs, seeded directly so the
    // planner has enough rows that a full scan would be the alternative.
    const scaleGame = await db.pool.query<{ id: string }>(
      "insert into games (slug, name) values ('scale-title', 'Scale Title') returning id",
    );
    const scaleGameId = scaleGame.rows[0]!.id;
    const gpuRow = await db.pool.query<{ id: string }>(
      "insert into hardware (kind, vendor, canonical_name) values ('gpu', 'nvidia', 'Scale GPU') returning id",
    );
    const scaleGpuId = gpuRow.rows[0]!.id;

    await db.pool.query(
      `with inserted as (
         insert into runs (
           id, game_raw, game_id, capture_source, visibility, status,
           cpu_model, gpu_model, gpu_vendor, gpu_hardware_id,
           resolution, scene, settings_preset, upscaler, ray_tracing,
           generated_frame_tech, graphics_api, scene_type, vsync, vrr,
           methodology_manifest_version, capability_manifest_version,
           diagnostics_rule_generation, frames_object_key, schema_version,
           parser_version, is_warmup, created_at
         )
         select 'scale_' || value, 'Scale Title', $1, 'capframex', 'public', 'validated',
                'Scale CPU', 'Scale GPU', 'nvidia', $2,
                '2560x1440', 'Scene', 'Ultra', 'none', 'off',
                'none', 'dx12', 'benchmark-scene', false, false,
                1, 1, 1, 'runs/scale-' || value || '.parquet', 1,
                'scale', false, now()
           from generate_series(1, 400) value
         returning id
       )
       insert into run_summaries (
         run_id, avg_fps, p1_low_fps, p01_low_fps, frametime_p50_ms,
         frametime_p95_ms, frametime_p99_ms, stutter_count, generated_frame_pct,
         p01_low_confidence, sample_count, duration_seconds
       )
       select id, 100 + random() * 40, 80, 70, 8, 10, 12, 0, 0, 'high', 7200, 60
         from inserted`,
      [scaleGameId, scaleGpuId],
    );

    const client = await db.pool.connect();
    try {
      await client.query("analyze runs");
      await client.query("analyze run_summaries");
      await client.query("begin");
      await client.query("set local enable_seqscan = off");
      const plan = await client.query<{ "QUERY PLAN": unknown }>(
        `explain (format json)
         with observations as ${cohortObservationsSql()}
         select ${comparabilityKeySql("r")} as ck, count(*)
           from observations obs
           join runs r on r.id = obs.run_id
           join run_summaries s on s.run_id = r.id
          where r.game_id = $1
          group by ck`,
        [scaleGameId],
      );
      // The game filter must ride the partial game index, never a full runs scan.
      expect(JSON.stringify(plan.rows)).toContain("runs_game_id_idx");
    } finally {
      await client.query("rollback").catch(() => {});
      client.release();
    }
  });
});
