/**
 * Repository-layer regression coverage (Phase 4 §11.4/§11.5/§11.9/§11.10).
 * Real Postgres via the shared harness; see testing/test-db.ts for the policy.
 */

import { createHash } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { RUN_STATUS, RUN_VISIBILITY, validRun, validSummary } from "@heimdall/shared";
import type { Run } from "@heimdall/shared";
import { insertRun, readRun } from "../db";
import { createTestDb, testDbAvailable, type TestDb } from "../testing/test-db";
import { consumeRateLimit, pruneRateLimits } from "./rate-limit";
import {
  deleteRun,
  finalizeRun,
  readRunFinalizeState,
  readRunManagementTokenHash,
  readStalePendingRuns,
} from "./runs";
import {
  applyVerificationResult,
  claimNextVerificationJob,
  completeVerificationJob,
  failVerificationJob,
} from "./jobs";
import { resolveGameId, resolveHardwareId } from "./catalog";

const canRun = testDbAvailable("repo.test");

function pendingRun(id: string): Run {
  return {
    ...validRun,
    id,
    status: RUN_STATUS.pending,
    visibility: RUN_VISIBILITY.unlisted,
    framesObjectKey: undefined,
    signatureValid: undefined,
  };
}

/** Unique per run — a shared constant would trip the unique hash index. */
function tokenHashFor(id: string): string {
  return createHash("sha256").update(id).digest("hex");
}

async function finalizeFixture(db: TestDb["pool"], id: string) {
  await insertRun(pendingRun(id), db);
  return finalizeRun(
    {
      id,
      framesObjectKey: `runs/${id}.parquet`,
      visibility: RUN_VISIBILITY.unlisted,
      managementTokenHash: tokenHashFor(id),
      signature: null,
      gameId: null,
      gpuHardwareId: null,
      cpuHardwareId: null,
    },
    db,
  );
}

describe.skipIf(!canRun)("repo layer (Phase 4)", () => {
  let db: TestDb;

  beforeAll(async () => {
    db = await createTestDb();
  }, 240_000);

  afterAll(async () => {
    await db?.teardown();
  });

  describe("rate limiting (§11.10)", () => {
    it("allows up to the limit inside one window, then rejects with a retry hint", async () => {
      for (let i = 0; i < 3; i++) {
        const result = await consumeRateLimit("test-create", "1.2.3.4", 3, 3600, db.pool);
        expect(result.allowed, `request ${i + 1} within limit`).toBe(true);
      }
      const rejected = await consumeRateLimit("test-create", "1.2.3.4", 3, 3600, db.pool);
      expect(rejected.allowed).toBe(false);
      expect(rejected.retryAfterSeconds).toBeGreaterThanOrEqual(1);
      expect(rejected.retryAfterSeconds).toBeLessThanOrEqual(3600);
    });

    it("scopes buckets by scope + client key", async () => {
      await consumeRateLimit("test-scope-a", "9.9.9.9", 1, 3600, db.pool);
      const otherScope = await consumeRateLimit("test-scope-b", "9.9.9.9", 1, 3600, db.pool);
      const otherIp = await consumeRateLimit("test-scope-a", "8.8.8.8", 1, 3600, db.pool);
      expect(otherScope.allowed).toBe(true);
      expect(otherIp.allowed).toBe(true);
    });

    it("prunes only expired windows", async () => {
      await db.pool.query(
        `insert into rate_limits (bucket, window_start, count)
         values ('test-old:ip', now() - interval '2 days', 5)`,
      );
      const pruned = await pruneRateLimits(db.pool);
      expect(pruned).toBeGreaterThanOrEqual(1);
      const remaining = await db.pool.query(
        "select 1 from rate_limits where bucket = 'test-old:ip'",
      );
      expect(remaining.rows).toEqual([]);
      const live = await db.pool.query(
        "select 1 from rate_limits where bucket like 'test-create:%'",
      );
      expect(live.rows.length).toBeGreaterThan(0);
    });
  });

  describe("finalize + enqueue (§11.4/§11.5, 12.3)", () => {
    it("finalizes a pending run and enqueues its verification job atomically", async () => {
      expect(await finalizeFixture(db.pool, "run_fin_0001")).toBe(true);

      const state = await readRunFinalizeState("run_fin_0001", db.pool);
      expect(state).toEqual({
        status: RUN_STATUS.pending,
        framesObjectKey: "runs/run_fin_0001.parquet",
      });
      const jobs = await db.pool.query(
        "select status from verification_jobs where run_id = 'run_fin_0001'",
      );
      expect(jobs.rows).toEqual([{ status: "pending" }]);
    });

    it("re-finalize is a no-op: no second job row, returns false (12.3)", async () => {
      await finalizeFixture(db.pool, "run_fin_0002");
      const again = await finalizeRun(
        {
          id: "run_fin_0002",
          framesObjectKey: "runs/run_fin_0002.parquet",
          visibility: RUN_VISIBILITY.public,
          managementTokenHash: null,
          signature: null,
          gameId: null,
          gpuHardwareId: null,
          cpuHardwareId: null,
        },
        db.pool,
      );
      expect(again).toBe(false);
      const jobs = await db.pool.query(
        "select 1 from verification_jobs where run_id = 'run_fin_0002'",
      );
      expect(jobs.rows).toHaveLength(1);
      // The original finalize's visibility survives the replay.
      const run = await readRun("run_fin_0002", db.pool);
      expect(run?.visibility).toBe(RUN_VISIBILITY.unlisted);
    });

    it("returns false for a missing run", async () => {
      expect(
        await finalizeRun(
          {
            id: "run_missing",
            framesObjectKey: "runs/run_missing.parquet",
            visibility: RUN_VISIBILITY.unlisted,
            managementTokenHash: null,
            signature: null,
            gameId: null,
            gpuHardwareId: null,
            cpuHardwareId: null,
          },
          db.pool,
        ),
      ).toBe(false);
      expect(await readRunFinalizeState("run_missing", db.pool)).toBeNull();
    });

    it("exposes the token hash only through the narrow reader (12.6 support)", async () => {
      await finalizeFixture(db.pool, "run_fin_0003");
      const tokenState = await readRunManagementTokenHash("run_fin_0003", db.pool);
      expect(tokenState).toEqual({
        tokenHash: tokenHashFor("run_fin_0003"),
        framesObjectKey: "runs/run_fin_0003.parquet",
      });
      // The general read path never carries the hash.
      const run = await readRun("run_fin_0003", db.pool);
      expect(JSON.stringify(run)).not.toContain(tokenHashFor("run_fin_0003"));
    });

    it("deleteRun removes the row and cascades", async () => {
      await finalizeFixture(db.pool, "run_del_0001");
      expect(await deleteRun("run_del_0001", db.pool)).toBe(true);
      expect(await deleteRun("run_del_0001", db.pool)).toBe(false);
      const jobs = await db.pool.query(
        "select 1 from verification_jobs where run_id = 'run_del_0001'",
      );
      expect(jobs.rows).toEqual([]);
    });
  });

  describe("verification job queue (§11.5, 12.5)", () => {
    beforeEach(async () => {
      // Finalize tests above enqueue jobs too — each queue test starts empty.
      await db.pool.query("delete from verification_jobs");
    });

    it("claim -> complete lifecycle, and empty queue claims return null", async () => {
      await insertRun(pendingRun("run_job_0001"), db.pool);
      await finalizeFixture(db.pool, "run_job_0002");
      // Only run_job_0002 has a job (finalizeFixture enqueues it).
      const claimed = await claimNextVerificationJob({}, db.pool);
      expect(claimed).not.toBeNull();
      expect(claimed?.runId).toBe("run_job_0002");
      expect(claimed?.attempts).toBe(1);

      // Nothing else is claimable while the job is running with a fresh lock.
      expect(await claimNextVerificationJob({}, db.pool)).toBeNull();

      await completeVerificationJob(claimed!.id, db.pool);
      const done = await db.pool.query(
        "select status, locked_at from verification_jobs where id = $1",
        [claimed!.id],
      );
      expect(done.rows[0]).toEqual({ status: "succeeded", locked_at: null });
      // Terminal jobs never come back.
      expect(await claimNextVerificationJob({}, db.pool)).toBeNull();
    });

    it("non-terminal failure returns the job to pending for a retry", async () => {
      await finalizeFixture(db.pool, "run_job_0003");
      const first = await claimNextVerificationJob({}, db.pool);
      expect(first?.runId).toBe("run_job_0003");
      await failVerificationJob(first!.id, "transient: R2 timeout", false, db.pool);

      const second = await claimNextVerificationJob({}, db.pool);
      expect(second?.id).toBe(first!.id);
      expect(second?.attempts).toBe(2);
      await failVerificationJob(second!.id, "terminal: corrupt parquet", true, db.pool);

      const finalState = await db.pool.query(
        "select status, last_error from verification_jobs where id = $1",
        [first!.id],
      );
      expect(finalState.rows[0]?.status).toBe("failed");
      expect(finalState.rows[0]?.last_error).toContain("corrupt parquet");
      expect(await claimNextVerificationJob({}, db.pool)).toBeNull();
    });

    it("reaps a stuck running job once its lock goes stale (12.5 durability)", async () => {
      await finalizeFixture(db.pool, "run_job_0004");
      const crashed = await claimNextVerificationJob({}, db.pool);
      expect(crashed?.runId).toBe("run_job_0004");
      // Simulate a worker crash: job left `running`, lock long stale.
      await db.pool.query(
        "update verification_jobs set locked_at = now() - interval '1 hour' where id = $1",
        [crashed!.id],
      );
      const reclaimed = await claimNextVerificationJob({ staleRunningMinutes: 10 }, db.pool);
      expect(reclaimed?.id).toBe(crashed!.id);
      expect(reclaimed?.attempts).toBe(2);
      await completeVerificationJob(reclaimed!.id, db.pool);
    });

    it("applyVerificationResult overwrites the summary and moves run status", async () => {
      await finalizeFixture(db.pool, "run_job_0005");
      const corrected = { ...validSummary, avgFps: 100.5, stutterCount: 7 };
      await applyVerificationResult("run_job_0005", corrected, "flagged", false, db.pool);
      const run = await readRun("run_job_0005", db.pool);
      expect(run?.status).toBe(RUN_STATUS.flagged);
      expect(run?.summary.avgFps).toBe(100.5);
      expect(run?.summary.stutterCount).toBe(7);
      expect(run?.signatureValid).toBe(false);
    });
  });

  describe("stale pending reaper query (§11.11)", () => {
    it("returns only unfinalized runs past the TTL", async () => {
      await insertRun(pendingRun("run_stale_0001"), db.pool);
      await insertRun(pendingRun("run_stale_fresh"), db.pool);
      await finalizeFixture(db.pool, "run_stale_finalized");
      // The shared fixture pins createdAt to a past date — set ages explicitly.
      await db.pool.query(
        "update runs set created_at = now() - interval '48 hours' where id in ($1, $2)",
        ["run_stale_0001", "run_stale_finalized"],
      );
      await db.pool.query("update runs set created_at = now() where id = $1", [
        "run_stale_fresh",
      ]);
      const stale = await readStalePendingRuns(24, 10, db.pool);
      expect(stale).toContain("run_stale_0001");
      expect(stale).not.toContain("run_stale_fresh"); // too young
      expect(stale).not.toContain("run_stale_finalized"); // has an object key
    });
  });

  describe("canonical resolution (§11.9)", () => {
    it("match-or-creates a game and reuses it across alias variants", async () => {
      const first = await resolveGameId("capframex", "Cyberpunk 2077", db.pool);
      expect(first).toBeTruthy();
      // Same title, different casing/spacing/source → same canonical id.
      const second = await resolveGameId("user", "  CYBERPUNK   2077 ", db.pool);
      expect(second).toBe(first);

      const games = await db.pool.query(
        "select slug, name from games where slug = 'cyberpunk-2077'",
      );
      expect(games.rows).toEqual([{ slug: "cyberpunk-2077", name: "Cyberpunk 2077" }]);
      const aliases = await db.pool.query(
        "select source from game_aliases where game_id = $1 order by source",
        [first],
      );
      expect(aliases.rows.map((r: { source: string }) => r.source)).toEqual([
        "capframex",
        "user",
      ]);
    });

    it("match-or-creates hardware keyed by kind + folded name", async () => {
      const gpu = await resolveHardwareId(
        "gpu",
        "capframex",
        "NVIDIA GeForce RTX™ 4070",
        "nvidia",
        db.pool,
      );
      expect(gpu).toBeTruthy();
      const again = await resolveHardwareId(
        "gpu",
        "presentmon",
        "nvidia geforce rtx 4070",
        "nvidia",
        db.pool,
      );
      expect(again).toBe(gpu);

      const rows = await db.pool.query(
        "select kind, vendor, canonical_name from hardware where id = $1",
        [gpu],
      );
      // Marks stripped, display casing kept (first writer wins).
      expect(rows.rows).toEqual([
        { kind: "gpu", vendor: "nvidia", canonical_name: "NVIDIA GeForce RTX 4070" },
      ]);

      // A CPU with the same name string would be a separate canonical row.
      const cpu = await resolveHardwareId("cpu", "capframex", "AMD Ryzen 7 7800X3D", null, db.pool);
      expect(cpu).not.toBe(gpu);
    });

    it("returns null (non-fatal) for blank names", async () => {
      expect(await resolveGameId("user", "   ", db.pool)).toBeNull();
      expect(await resolveHardwareId("cpu", "user", " ™ ", null, db.pool)).toBeNull();
    });
  });
});
