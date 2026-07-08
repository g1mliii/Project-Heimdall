/**
 * Verification worker regression coverage (§11.5; plan items 12.4/12.5).
 * Real Postgres via the shared harness; R2 is replaced by injected deps —
 * the Parquet bytes are built IN-TEST with the same writer the browser uses,
 * so this doubles as the write→read→recompute round-trip proof.
 */

import { generateKeyPairSync, sign as cryptoSign } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { parquetWriteBuffer } from "hyparquet-writer";
import { computeRunSummary } from "@heimdall/parsers";
import {
  RUN_STATUS,
  RUN_VISIBILITY,
  aggregateEligibilitySql,
  framesToColumnData,
  validFrames,
  validRun,
} from "@heimdall/shared";
import type { FrameSample, Run } from "@heimdall/shared";
import { insertRun, readRun } from "../db";
import { createTestDb, testDbAvailable, type TestDb } from "../testing/test-db";
import { finalizeRun } from "../repo/runs";
import {
  MAX_VERIFICATION_ATTEMPTS,
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

    // Idempotent: nothing left to drain.
    const again = await drainJobs({}, realDeps(async () => parquetBytes));
    expect(again.claimed).toBe(0);
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

  it("transient storage error retries; the attempts cap terminalizes (12.5)", async () => {
    await setupFinalizedRun("run_wk_retry");
    const flaky = async () => {
      throw new Error("simulated R2 outage");
    };

    const first = await drainJobs({}, realDeps(flaky));
    expect(first).toMatchObject({ claimed: 1, retried: 1, failed: 0 });
    let jobs = await db.pool.query("select status, attempts from verification_jobs");
    expect(jobs.rows[0]).toMatchObject({ status: "pending", attempts: 1 });

    // Fast-forward to the last allowed attempt.
    await db.pool.query("update verification_jobs set attempts = $1", [
      MAX_VERIFICATION_ATTEMPTS - 1,
    ]);
    const last = await drainJobs({}, realDeps(flaky));
    expect(last).toMatchObject({ claimed: 1, failed: 1 });
    jobs = await db.pool.query("select status, last_error from verification_jobs");
    expect(jobs.rows[0]?.status).toBe("failed");
    expect(jobs.rows[0]?.last_error).toContain("R2 outage");

    // The run never validated — and never becomes aggregate-eligible.
    const run = await readRun("run_wk_retry", db.pool);
    expect(run?.status).toBe(RUN_STATUS.pending);
  });

  it("corrupt parquet is a terminal failure; run stays pending (12.5)", async () => {
    await setupFinalizedRun("run_wk_corrupt");
    const garbage = new Uint8Array([0x50, 0x41, 0x52, 0x31, 1, 2, 3, 4]);
    const result = await drainJobs({}, realDeps(async () => garbage));
    expect(result).toMatchObject({ claimed: 1, failed: 1 });
    const run = await readRun("run_wk_corrupt", db.pool);
    expect(run?.status).toBe(RUN_STATUS.pending);
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
    expect(deleted).toContain("runs/run_wk_stale.parquet");
    expect(await readRun("run_wk_stale", db.pool)).toBeNull();
  });
});
