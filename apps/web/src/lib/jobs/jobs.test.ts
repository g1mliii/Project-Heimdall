/**
 * Verification worker regression coverage (§11.5; plan items 12.4/12.5).
 * Real Postgres via the shared harness; R2 is replaced by injected deps —
 * the Parquet bytes are built IN-TEST with the same writer the browser uses,
 * so this doubles as the write→read→recompute round-trip proof.
 */

import { generateKeyPairSync, sign as cryptoSign } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { parquetWriteBuffer } from "hyparquet-writer";
import { computeRunSummary, deriveCapabilityManifest } from "@heimdall/parsers";
import {
  RUN_STATUS,
  RUN_VISIBILITY,
  GENERATED_FRAME_TECH,
  aggregateEligibilitySql,
  framesToColumnData,
  validFrames,
  validRun,
} from "@heimdall/shared";
import type { FrameSample, MethodologyManifest, Run } from "@heimdall/shared";
import { insertRun, readRun } from "../db";
import { framesUploadObjectKey, stagingCleanupNotBefore } from "../r2";
import { createTestDb, testDbAvailable, type TestDb } from "../testing/test-db";
import { finalizeRun, readVisibleRun } from "../repo/runs";
import {
  MAX_VERIFICATION_ATTEMPTS,
  cleanupFinalizedStaging,
  cleanupStalePending,
  drainJobs,
  type DrainDeps,
} from "./drain";

const canRun = testDbAvailable("jobs.test");

/** ≥ minFramesPerRun samples with a realistic spread (validFrames is 16). */
const frames: FrameSample[] = validFrames;
const honestSummary = computeRunSummary(frames);

function makeParquet(input: readonly FrameSample[]): Uint8Array {
  return new Uint8Array(parquetWriteBuffer({ columnData: framesToColumnData(input) }));
}

const parquetBytes = makeParquet(frames);

function stagingCleanup(id: string) {
  return {
    objectKey: framesUploadObjectKey(id),
    notBefore: stagingCleanupNotBefore(),
  };
}

function runFixture(id: string, overrides: Partial<Run> = {}): Run {
  return {
    ...validRun,
    id,
    status: RUN_STATUS.pending,
    visibility: RUN_VISIBILITY.unlisted,
    summary: honestSummary,
    framesObjectKey: undefined,
    signatureValid: undefined,
    ...overrides,
  };
}

describe.skipIf(!canRun)("verification worker (§11.5)", () => {
  let db: TestDb;

  const deps = (getObject: DrainDeps["getObject"]): DrainDeps => ({
    db: undefined as never, // set per-call below
    getObject,
    deleteObject: async () => {},
  });

  function realDeps(getObject: DrainDeps["getObject"], publicKeyBase64?: string): DrainDeps {
    return { ...deps(getObject), db: db.pool, publicKeyBase64 };
  }

  async function setupFinalizedRun(id: string, run: Run = runFixture(id)): Promise<void> {
    await insertRun(run, db.pool);
    const ok = await finalizeRun(
      {
        id,
        framesObjectKey: `runs/${id}.parquet`,
        stagingCleanup: stagingCleanup(id),
        visibility: run.visibility,
        managementTokenHash: null,
        signature: null,
        gameId: null,
        gpuHardwareId: null,
        cpuHardwareId: null,
      },
      db.pool,
    );
    expect(ok).toBe(true);
  }

  beforeAll(async () => {
    db = await createTestDb();
  }, 240_000);

  afterAll(async () => {
    await db?.teardown();
  });

  beforeEach(async () => {
    await db.pool.query("delete from verification_jobs");
  });

  it("honest upload: recompute matches, run becomes validated (12.4)", async () => {
    await setupFinalizedRun("run_wk_honest");
    const result = await drainJobs({}, realDeps(async () => parquetBytes));
    expect(result).toMatchObject({ claimed: 1, validated: 1, flagged: 0, failed: 0 });

    const run = await readRun("run_wk_honest", db.pool);
    expect(run?.status).toBe(RUN_STATUS.validated);
    // The recompute over DOUBLE columns is bit-identical to the client's.
    expect(run?.summary).toEqual(honestSummary);
    // The seeded currency catalog also produces an informational update. The
    // compact fixture has verified busy-time columns but fewer paired
    // samples than attribution permits. That yields an explanatory info
    // finding, never a hard bottleneck verdict (§16b / §16d.2).
    expect(run?.diagnostics).toMatchObject([
      {
        code: "driver-update-available",
        severity: "info",
      },
      {
        code: "telemetry-insufficient",
        severity: "info",
        confidence: "low",
      },
    ]);

    // Idempotent: nothing left to drain.
    const again = await drainJobs({}, realDeps(async () => parquetBytes));
    expect(again.claimed).toBe(0);
  });

  it("produces and persists diagnostics; a reclaimed retry replaces, never duplicates", async () => {
    const id = "run_wk_diagnostics";
    await setupFinalizedRun(
      id,
      runFixture(id, {
        // RAM below rated fires without any frame sensors — deterministic at the
        // worker level regardless of the (GPU-bound) synthetic frames.
        hardware: { ...validRun.hardware, ramSpeedMtps: 4800, ramRatedSpeedMtps: 6000 },
      }),
    );

    await drainJobs({}, realDeps(async () => parquetBytes));
    const run = await readRun(id, db.pool);
    expect(run?.status).toBe(RUN_STATUS.validated);
    expect(run?.diagnostics.map((d) => d.code)).toEqual([
      "ram-below-rated",
      "driver-update-available",
      "telemetry-insufficient",
    ]);
    const finding = run!.diagnostics[0]!;
    expect(finding.severity).toBe("warn");
    expect(finding.detail).toContain("4800");

    const countRows = async () =>
      (
        await db.pool.query<{ n: number }>(
          "select count(*)::int as n from diagnostics where run_id = $1",
          [id],
        )
      ).rows[0]!.n;
    expect(await countRows()).toBe(3);

    // Model a worker that stored findings then died before marking its job done;
    // the expired lease is reclaimed and the run re-verified.
    await db.pool.query(
      `update verification_jobs
          set status = 'running',
              locked_at = now() - interval '11 minutes',
              not_before = now() - interval '1 minute'
        where run_id = $1`,
      [id],
    );
    await drainJobs({}, realDeps(async () => parquetBytes));

    // Delete-then-insert keeps the three distinct findings stable across the retry.
    expect(await countRows()).toBe(3);
    const rerun = await readRun(id, db.pool);
    expect(rerun?.diagnostics.map((d) => d.code)).toEqual([
      "ram-below-rated",
      "driver-update-available",
      "telemetry-insufficient",
    ]);
  });

  it("tampered client summary is corrected AND flagged (12.4)", async () => {
    await setupFinalizedRun(
      "run_wk_tampered",
      runFixture("run_wk_tampered", {
        summary: { ...honestSummary, avgFps: 999.9, onePercentLowFps: 998 },
      }),
    );
    const result = await drainJobs({}, realDeps(async () => parquetBytes));
    expect(result).toMatchObject({ claimed: 1, flagged: 1, validated: 0 });

    const run = await readRun("run_wk_tampered", db.pool);
    expect(run?.status).toBe(RUN_STATUS.flagged);
    // Stored numbers are now the server's, not the client's lie.
    expect(run?.summary.avgFps).toBe(honestSummary.avgFps);
  });

  it("preserves a flagged verdict when a stale verification job is reclaimed", async () => {
    const id = "run_wk_tampered_reclaimed";
    await setupFinalizedRun(
      id,
      runFixture(id, {
        visibility: RUN_VISIBILITY.public,
        summary: { ...honestSummary, avgFps: 999.9, onePercentLowFps: 998 },
      }),
    );
    expect(await drainJobs({}, realDeps(async () => parquetBytes))).toMatchObject({ flagged: 1 });
    expect((await readRun(id, db.pool))?.status).toBe(RUN_STATUS.flagged);

    // Model a worker dying after it stored the canonical flagged summary but
    // before it marked its job succeeded; the expired lease is then reclaimed.
    await db.pool.query(
      `update verification_jobs
          set status = 'running',
              locked_at = now() - interval '11 minutes',
              not_before = now() - interval '1 minute'
        where run_id = $1`,
      [id],
    );
    expect(await drainJobs({}, realDeps(async () => parquetBytes))).toMatchObject({ flagged: 1, validated: 0 });
    expect((await readRun(id, db.pool))?.status).toBe(RUN_STATUS.flagged);
  });

  it("canonical recompute corrects ambiguous generated-frame metadata", async () => {
    const generatedFrames = frames.map((frame, index) => ({
      ...frame,
      generated: index % 2 === 0,
    }));
    const generatedSummary = computeRunSummary(generatedFrames);
    await setupFinalizedRun(
      "run_wk_generated",
      runFixture("run_wk_generated", {
        summary: generatedSummary,
        generatedFrameTech: GENERATED_FRAME_TECH.none,
      }),
    );

    const result = await drainJobs({}, realDeps(async () => makeParquet(generatedFrames)));
    expect(result).toMatchObject({ claimed: 1, validated: 1 });
    expect((await readRun("run_wk_generated", db.pool))?.generatedFrameTech).toBe(
      GENERATED_FRAME_TECH.unknown,
    );
  });

  it("canonical recompute resets vendor frame generation when no frames are generated", async () => {
    const id = "run_wk_native";
    await setupFinalizedRun(
      id,
      runFixture(id, { generatedFrameTech: GENERATED_FRAME_TECH.dlss3 }),
    );

    const result = await drainJobs({}, realDeps(async () => parquetBytes));

    expect(result).toMatchObject({ claimed: 1, validated: 1 });
    expect((await readRun(id, db.pool))?.generatedFrameTech).toBe(GENERATED_FRAME_TECH.none);
  });

  it("keeps persisted methodology aligned with canonical resolution and frame generation", async () => {
    const id = "run_wk_methodology";
    const methodologyManifest: MethodologyManifest = {
      version: 1,
      sceneType: "benchmark-scene",
      resolution: "1920x1080", // stale declaration; parsed hardware says 1440p.
      upscaler: "dlss",
      rayTracing: "on",
      frameGeneration: GENERATED_FRAME_TECH.dlss3,
      framePacing: { vsync: false, vrr: true },
    };
    await setupFinalizedRun(
      id,
      runFixture(id, {
        generatedFrameTech: GENERATED_FRAME_TECH.dlss3,
        methodologyManifest,
      }),
    );

    expect(await drainJobs({}, realDeps(async () => parquetBytes))).toMatchObject({ validated: 1 });
    expect((await readRun(id, db.pool))?.methodologyManifest).toEqual({
      ...methodologyManifest,
      resolution: validRun.hardware.resolution,
      frameGeneration: GENERATED_FRAME_TECH.none,
    });
  });

  it("retains declared unified-memory VRAM state through verification", async () => {
    const id = "run_wk_unified_memory";
    const capabilityManifest = deriveCapabilityManifest(
      frames,
      "capframex",
      { ...validRun.hardware, gpuVramTotalMb: undefined },
    );
    capabilityManifest.vramCapacity = { state: "unified-memory" };
    await setupFinalizedRun(
      id,
      runFixture(id, {
        hardware: { ...validRun.hardware, gpuVramTotalMb: undefined },
        capabilityManifest,
      }),
    );

    expect(await drainJobs({}, realDeps(async () => parquetBytes))).toMatchObject({ validated: 1 });
    expect((await readRun(id, db.pool))?.capabilityManifest?.vramCapacity).toEqual({
      state: "unified-memory",
    });
  });

  it("retains declared periodic sensor alignment through canonical verification", async () => {
    const id = "run_wk_sensor_alignment";
    const capabilityManifest = deriveCapabilityManifest(frames, "capframex", validRun.hardware, {
      sensorAlignment: { gpuLoadPct: false, gpuPowerW: false },
    });
    await setupFinalizedRun(id, runFixture(id, { capabilityManifest }));

    expect(await drainJobs({}, realDeps(async () => parquetBytes))).toMatchObject({ validated: 1 });
    const verified = (await readRun(id, db.pool))?.capabilityManifest;
    expect(verified?.sensors.gpuLoadPct).toEqual({ present: true, frameAligned: false });
    expect(verified?.sensors.gpuPowerW).toEqual({ present: true, frameAligned: false });
    expect(verified?.sensors.cpuBusyMs).toEqual({ present: true, frameAligned: true });
  });

  it("transient storage error retries; the attempts cap terminalizes (12.5)", async () => {
    await setupFinalizedRun("run_wk_retry");
    const flaky = async () => {
      throw new Error("simulated R2 outage");
    };

    const first = await drainJobs({}, realDeps(flaky));
    expect(first).toMatchObject({ claimed: 1, retried: 1, failed: 0 });
    let jobs = await db.pool.query(
      "select status, attempts, not_before > now() as delayed from verification_jobs",
    );
    expect(jobs.rows[0]).toMatchObject({ status: "pending", attempts: 1, delayed: true });
    expect((await readRun("run_wk_retry", db.pool))?.status).toBe(RUN_STATUS.pending);

    // The same drain cycle (or a newly triggered worker) cannot burn every
    // remaining attempt while the backing store is still unavailable.
    expect(await drainJobs({}, realDeps(flaky))).toMatchObject({ claimed: 0 });

    // Fast-forward to the last allowed attempt.
    await db.pool.query(
      "update verification_jobs set attempts = $1, not_before = now() - interval '1 minute'",
      [MAX_VERIFICATION_ATTEMPTS - 1],
    );
    const last = await drainJobs({}, realDeps(flaky));
    expect(last).toMatchObject({ claimed: 1, failed: 1 });
    jobs = await db.pool.query("select status, last_error from verification_jobs");
    expect(jobs.rows[0]?.status).toBe("failed");
    expect(jobs.rows[0]?.last_error).toContain("R2 outage");

    // The run never validated and is no longer visible before ownership exists.
    const run = await readRun("run_wk_retry", db.pool);
    expect(run?.status).toBe(RUN_STATUS.flagged);
  });

  it("corrupt parquet is terminally flagged and hidden from pre-auth reads (12.5)", async () => {
    await setupFinalizedRun(
      "run_wk_corrupt",
      runFixture("run_wk_corrupt", { visibility: RUN_VISIBILITY.public }),
    );
    const garbage = new Uint8Array([0x50, 0x41, 0x52, 0x31, 1, 2, 3, 4]);
    const result = await drainJobs({}, realDeps(async () => garbage));
    expect(result).toMatchObject({ claimed: 1, failed: 1 });
    const run = await readRun("run_wk_corrupt", db.pool);
    expect(run?.status).toBe(RUN_STATUS.flagged);
    expect(await readVisibleRun("run_wk_corrupt", db.pool)).toBeNull();
  });

  it("rejects invalid report-only columns before a run can validate", async () => {
    const id = "run_wk_invalid_report_column";
    await setupFinalizedRun(id);
    const invalidReportFrames = frames.map((frame, index) =>
      index === 0 ? { ...frame, gpuLoadPct: 101 } : frame,
    );

    const result = await drainJobs({}, realDeps(async () => makeParquet(invalidReportFrames)));

    expect(result).toMatchObject({ claimed: 1, failed: 1, validated: 0 });
    expect((await readRun(id, db.pool))?.status).toBe(RUN_STATUS.flagged);
  });

  it("pending/flagged runs never match the aggregate-eligibility guard (12.5)", async () => {
    // public visibility but never-validated / flagged — must stay invisible.
    await setupFinalizedRun(
      "run_wk_agg_pending",
      runFixture("run_wk_agg_pending", { visibility: RUN_VISIBILITY.public }),
    );
    await setupFinalizedRun(
      "run_wk_agg_flagged",
      runFixture("run_wk_agg_flagged", {
        visibility: RUN_VISIBILITY.public,
        summary: { ...honestSummary, avgFps: 555 },
      }),
    );
    await drainJobs({ maxJobs: 2 }, realDeps(async () => parquetBytes));

    const eligible = await db.pool.query<{ id: string }>(
      `select runs.id from runs where ${aggregateEligibilitySql()} and runs.id like 'run_wk_agg_%'`,
    );
    // Only the honest public run (validated by the drain above) qualifies.
    expect(eligible.rows.map((r) => r.id)).toEqual(["run_wk_agg_pending"]);
    const flagged = await readRun("run_wk_agg_flagged", db.pool);
    expect(flagged?.status).toBe(RUN_STATUS.flagged);
  });

  it("records signature_valid as evidence, never gatekeeping (§11.7)", async () => {
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const publicKeyBase64 = publicKey.export({ format: "der", type: "spki" }).toString("base64");
    const goodSig = cryptoSign(null, parquetBytes, privateKey).toString("base64");

    await insertRun(runFixture("run_wk_signed"), db.pool);
    await finalizeRun(
      {
        id: "run_wk_signed",
        framesObjectKey: "runs/run_wk_signed.parquet",
        stagingCleanup: stagingCleanup("run_wk_signed"),
        visibility: RUN_VISIBILITY.unlisted,
        managementTokenHash: null,
        signature: goodSig,
        gameId: null,
        gpuHardwareId: null,
        cpuHardwareId: null,
      },
      db.pool,
    );
    await drainJobs({}, realDeps(async () => parquetBytes, publicKeyBase64));
    expect((await readRun("run_wk_signed", db.pool))?.signatureValid).toBe(true);

    // A bogus signature still validates the RUN (summary is honest) but
    // records the evidence as false.
    await insertRun(runFixture("run_wk_badsig"), db.pool);
    await finalizeRun(
      {
        id: "run_wk_badsig",
        framesObjectKey: "runs/run_wk_badsig.parquet",
        stagingCleanup: stagingCleanup("run_wk_badsig"),
        visibility: RUN_VISIBILITY.unlisted,
        managementTokenHash: null,
        signature: Buffer.from("forged").toString("base64"),
        gameId: null,
        gpuHardwareId: null,
        cpuHardwareId: null,
      },
      db.pool,
    );
    await drainJobs({}, realDeps(async () => parquetBytes, publicKeyBase64));
    const badSigRun = await readRun("run_wk_badsig", db.pool);
    expect(badSigRun?.signatureValid).toBe(false);
    expect(badSigRun?.status).toBe(RUN_STATUS.validated);
  });

  it("reaps stale never-finalized runs and their blind object keys (§11.11, 12.6)", async () => {
    await insertRun(runFixture("run_wk_stale"), db.pool);
    await db.pool.query("update runs set created_at = now() - interval '30 hours' where id = $1", [
      "run_wk_stale",
    ]);
    const deleted: string[] = [];
    const cleaned = await cleanupStalePending({
      db: db.pool,
      deleteObject: async (key) => {
        deleted.push(key);
      },
    });
    expect(cleaned).toBeGreaterThanOrEqual(1);
    expect(deleted).toContain("staging/runs/run_wk_stale.parquet");
    expect(await readRun("run_wk_stale", db.pool)).toBeNull();
  });

  it("keeps a stale row when staging-object deletion fails so cleanup can retry", async () => {
    const id = "run_wk_stale_retry";
    await insertRun(runFixture(id), db.pool);
    await db.pool.query("update runs set created_at = now() - interval '30 hours' where id = $1", [
      id,
    ]);

    await cleanupStalePending({
      db: db.pool,
      deleteObject: async (key) => {
        if (key === `staging/runs/${id}.parquet`) {
          throw new Error("simulated R2 outage");
        }
      },
    });

    expect(await readRun(id, db.pool)).not.toBeNull();
  });

  it("reaps expired finalized staging objects after the PUT window closes", async () => {
    const id = "run_wk_finalized_staging";
    await setupFinalizedRun(id);
    await db.pool.query(
      "update staging_cleanup_jobs set not_before = now() - interval '1 minute' where run_id = $1",
      [id],
    );
    const deleted: string[] = [];

    expect(
      await cleanupFinalizedStaging(
        {
          db: db.pool,
          deleteObject: async (key) => {
            deleted.push(key);
          },
        },
        { deadlineAt: Date.now() - 1 },
      ),
    ).toBe(0);
    expect(deleted).toEqual([]);

    const cleaned = await cleanupFinalizedStaging({
      db: db.pool,
      deleteObject: async (key) => {
        deleted.push(key);
      },
    });

    expect(cleaned).toBeGreaterThanOrEqual(1);
    expect(deleted).toContain(`staging/runs/${id}.parquet`);
    expect(
      (await db.pool.query("select 1 from staging_cleanup_jobs where run_id = $1", [id])).rows,
    ).toEqual([]);
  });

  it("claims finalized staging cleanup once across concurrent maintenance passes", async () => {
    const id = "run_wk_finalized_staging_concurrent";
    await setupFinalizedRun(id);
    await db.pool.query(
      "update staging_cleanup_jobs set not_before = now() - interval '1 minute' where run_id = $1",
      [id],
    );

    let deleteCount = 0;
    let releaseDelete!: () => void;
    let signalDeleteStarted!: () => void;
    const deleteStarted = new Promise<void>((resolve) => {
      signalDeleteStarted = resolve;
    });
    const holdDelete = new Promise<void>((resolve) => {
      releaseDelete = resolve;
    });
    const deps = {
      db: db.pool,
      deleteObject: async () => {
        deleteCount += 1;
        signalDeleteStarted();
        await holdDelete;
      },
    };

    const first = cleanupFinalizedStaging(deps);
    await deleteStarted;
    const second = cleanupFinalizedStaging(deps);
    expect(
      await Promise.race([
        second,
        new Promise<"timed-out">((resolve) => setTimeout(() => resolve("timed-out"), 100)),
      ]),
    ).toBe(0);

    releaseDelete();
    await Promise.all([first, second]);
    expect(deleteCount).toBe(1);
  });

  it("keeps failed finalized staging cleanup durable for a later retry", async () => {
    const id = "run_wk_finalized_staging_retry";
    await setupFinalizedRun(id);
    await db.pool.query(
      "update staging_cleanup_jobs set not_before = now() - interval '1 minute' where run_id = $1",
      [id],
    );

    await cleanupFinalizedStaging({
      db: db.pool,
      deleteObject: async () => {
        throw new Error("simulated R2 outage");
      },
    });

    const pending = await db.pool.query<{ attempts: number; last_error: string }>(
      "select attempts, last_error from staging_cleanup_jobs where run_id = $1",
      [id],
    );
    expect(pending.rows[0]).toMatchObject({ attempts: 1, last_error: "Error: simulated R2 outage" });

    await db.pool.query(
      "update staging_cleanup_jobs set not_before = now() - interval '1 minute' where run_id = $1",
      [id],
    );
    expect(
      await cleanupFinalizedStaging({ db: db.pool, deleteObject: async () => {} }),
    ).toBeGreaterThanOrEqual(1);
    expect(
      (await db.pool.query("select 1 from staging_cleanup_jobs where run_id = $1", [id])).rows,
    ).toEqual([]);
  });

  it("does not delete a stale run that finalizes after the reaper reads it", async () => {
    const id = "run_wk_stale_race";
    const finalizedKey = `runs/${id}.parquet`;
    await insertRun(runFixture(id), db.pool);
    await db.pool.query("update runs set created_at = now() - interval '30 hours' where id = $1", [
      id,
    ]);

    let finalizedDuringCleanup = false;
    await cleanupStalePending({
      db: db.pool,
      deleteObject: async (key) => {
        if (key !== `staging/runs/${id}.parquet`) {
          return;
        }
        finalizedDuringCleanup = await finalizeRun(
          {
            id,
            framesObjectKey: finalizedKey,
            stagingCleanup: stagingCleanup(id),
            visibility: RUN_VISIBILITY.unlisted,
            managementTokenHash: null,
            signature: null,
            gameId: null,
            gpuHardwareId: null,
            cpuHardwareId: null,
          },
          db.pool,
        );
      },
    });

    expect(finalizedDuringCleanup).toBe(true);
    expect((await readRun(id, db.pool))?.framesObjectKey).toBe(finalizedKey);
    expect(
      (await db.pool.query("select 1 from verification_jobs where run_id = $1", [id])).rows,
    ).toHaveLength(1);
  });
});
