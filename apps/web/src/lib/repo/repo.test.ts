/**
 * Repository-layer regression coverage (Phase 4 §11.4/§11.5/§11.9/§11.10).
 * Real Postgres via the shared harness; see testing/test-db.ts for the policy.
 */

import { createHash } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { RUN_STATUS, RUN_VISIBILITY, validRun, validSummary } from "@heimdall/shared";
import type { Run } from "@heimdall/shared";
import {
  insertRun,
  readDiagnostics,
  readRun,
  readRunForVerification,
  readRunRequiredDriver,
} from "../db";
import type { CapabilityManifest, DiagnosticFinding } from "@heimdall/shared";
import { framesUploadObjectKey, stagingCleanupNotBefore } from "../r2";
import { createTestDb, testDbAvailable, type TestDb } from "../testing/test-db";
import { consumeRateLimit, pruneRateLimits } from "./rate-limit";
import {
  deleteRun,
  finalizeRun,
  readVisibleBenchmarkSet,
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

function stagingCleanup(id: string) {
  return {
    objectKey: framesUploadObjectKey(id),
    notBefore: stagingCleanupNotBefore(),
  };
}

async function finalizeFixture(db: TestDb["pool"], id: string) {
  await insertRun(pendingRun(id), db);
  return finalizeRun(
    {
      id,
      framesObjectKey: `runs/${id}.parquet`,
      stagingCleanup: stagingCleanup(id),
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
      const cleanup = await db.pool.query(
        "select object_key from staging_cleanup_jobs where run_id = 'run_fin_0001'",
      );
      expect(cleanup.rows).toEqual([{ object_key: "staging/runs/run_fin_0001.parquet" }]);
    });

    it("re-finalize is a no-op: no second job row, returns false (12.3)", async () => {
      await finalizeFixture(db.pool, "run_fin_0002");
      const again = await finalizeRun(
        {
          id: "run_fin_0002",
          framesObjectKey: "runs/run_fin_0002.parquet",
          stagingCleanup: stagingCleanup("run_fin_0002"),
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
            stagingCleanup: stagingCleanup("run_missing"),
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

    it("deleteRun removes the row but preserves late staging cleanup", async () => {
      await finalizeFixture(db.pool, "run_del_0001");
      expect(await deleteRun("run_del_0001", db.pool)).toBe(true);
      expect(await deleteRun("run_del_0001", db.pool)).toBe(false);
      const jobs = await db.pool.query(
        "select 1 from verification_jobs where run_id = 'run_del_0001'",
      );
      expect(jobs.rows).toEqual([]);
      const cleanup = await db.pool.query(
        "select object_key from staging_cleanup_jobs where run_id = 'run_del_0001'",
      );
      expect(cleanup.rows).toEqual([{ object_key: "staging/runs/run_del_0001.parquet" }]);
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

      await completeVerificationJob(claimed!.id, claimed!.attempts, db.pool);
      const done = await db.pool.query(
        "select status, locked_at from verification_jobs where id = $1",
        [claimed!.id],
      );
      expect(done.rows[0]).toEqual({ status: "succeeded", locked_at: null });
      // Terminal jobs never come back.
      expect(await claimNextVerificationJob({}, db.pool)).toBeNull();
    });

    it("non-terminal failure returns the job to pending with durable backoff", async () => {
      await finalizeFixture(db.pool, "run_job_0003");
      const first = await claimNextVerificationJob({}, db.pool);
      expect(first?.runId).toBe("run_job_0003");
      await failVerificationJob(first!.id, first!.attempts, "transient: R2 timeout", false, db.pool);

      expect(await claimNextVerificationJob({}, db.pool)).toBeNull();
      await db.pool.query(
        "update verification_jobs set not_before = now() - interval '1 minute' where id = $1",
        [first!.id],
      );
      const second = await claimNextVerificationJob({}, db.pool);
      expect(second?.id).toBe(first!.id);
      expect(second?.attempts).toBe(2);
      await failVerificationJob(
        second!.id,
        second!.attempts,
        "terminal: corrupt parquet",
        true,
        db.pool,
      );

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
      // Simulate a worker crash: job left `running` with an expired lease.
      await db.pool.query(
        `update verification_jobs
            set locked_at = now() - interval '1 hour',
                not_before = now() - interval '1 minute'
          where id = $1`,
        [crashed!.id],
      );
      const reclaimed = await claimNextVerificationJob({ staleRunningMinutes: 10 }, db.pool);
      expect(reclaimed?.id).toBe(crashed!.id);
      expect(reclaimed?.attempts).toBe(2);
      await completeVerificationJob(reclaimed!.id, reclaimed!.attempts, db.pool);
    });

    it("applyVerificationResult overwrites the summary and moves run status", async () => {
      await finalizeFixture(db.pool, "run_job_0005");
      const corrected = { ...validSummary, avgFps: 100.5, stutterCount: 7 };
      const claimed = await claimNextVerificationJob({}, db.pool);
      expect(claimed?.runId).toBe("run_job_0005");
      await applyVerificationResult(
        "run_job_0005",
        {
          summary: corrected,
          runStatus: "flagged",
          signatureValid: false,
          diagnostics: [],
          capabilityManifest: null,
          methodologyManifest: null,
          generatedFrameTech: "none",
        },
        claimed!,
        db.pool,
      );
      await completeVerificationJob(claimed!.id, claimed!.attempts, db.pool);
      const run = await readRun("run_job_0005", db.pool);
      expect(run?.status).toBe(RUN_STATUS.flagged);
      expect(run?.summary.avgFps).toBe(100.5);
      expect(run?.summary.stutterCount).toBe(7);
      expect(run?.signatureValid).toBe(false);
    });

    it("persists the recomputed capability manifest + richer diagnostics, replacing on retry (§16a/§16b.2)", async () => {
      await finalizeFixture(db.pool, "run_job_manifest");
      const manifest: CapabilityManifest = {
        version: 1,
        source: "presentmon",
        sensors: Object.fromEntries(
          (["gpuLoadPct", "gpuClockMhz", "gpuPowerW", "vramUsedMb", "cpuLoadPct", "cpuBusyMs", "gpuBusyMs"] as const).map(
            (field) => [field, { present: field.endsWith("BusyMs"), frameAligned: field.endsWith("BusyMs") }],
          ),
        ) as CapabilityManifest["sensors"],
        presentationMode: "unknown",
        syncMode: "unknown",
        frameGenerationObserved: false,
        vramCapacity: { state: "unknown" },
        caveats: [],
      };
      const findings: DiagnosticFinding[] = [
        {
          code: "likely-gpu-bound",
          severity: "info",
          title: "Likely GPU-bound",
          detail: "GPU work dominated on most frames.",
          ruleVersion: "1.0.0",
          confidence: "high",
          evidence: { coverageFraction: 1, sensors: ["cpuBusyMs", "gpuBusyMs"], metrics: { gpuBoundFraction: 0.9 } },
        },
      ];

      const first = await claimNextVerificationJob({}, db.pool);
      expect(first?.runId).toBe("run_job_manifest");
      await applyVerificationResult(
        "run_job_manifest",
        {
          summary: validSummary,
          runStatus: "validated",
          signatureValid: null,
          diagnostics: findings,
          capabilityManifest: manifest,
          methodologyManifest: null,
          generatedFrameTech: "none",
        },
        first!,
        db.pool,
      );
      await completeVerificationJob(first!.id, first!.attempts, db.pool);

      const run = await readRun("run_job_manifest", db.pool);
      expect(run?.capabilityManifest).toEqual(manifest);
      const diagnostics = await readDiagnostics("run_job_manifest", db.pool);
      expect(diagnostics).toHaveLength(1);
      expect(diagnostics[0]).toMatchObject({
        code: "likely-gpu-bound",
        ruleVersion: "1.0.0",
        confidence: "high",
        evidence: { coverageFraction: 1, sensors: ["cpuBusyMs", "gpuBusyMs"], metrics: { gpuBoundFraction: 0.9 } },
      });

      // A second verification pass (reclaim) must REPLACE, not duplicate.
      await db.pool.query(
        `update verification_jobs set status = 'pending', locked_at = null, not_before = now() where run_id = $1`,
        ["run_job_manifest"],
      );
      const second = await claimNextVerificationJob({}, db.pool);
      await applyVerificationResult(
        "run_job_manifest",
        {
          summary: validSummary,
          runStatus: "validated",
          signatureValid: null,
          diagnostics: [],
          capabilityManifest: null,
          methodologyManifest: null,
          generatedFrameTech: "none",
        },
        second!,
        db.pool,
      );
      expect(await readDiagnostics("run_job_manifest", db.pool)).toEqual([]);
      // A null manifest clears the stored one.
      expect((await readRun("run_job_manifest", db.pool))?.capabilityManifest).toBeUndefined();
    });

    it("does not let a stale claim overwrite a newer completed verification", async () => {
      await finalizeFixture(db.pool, "run_job_stale_claim");
      const first = await claimNextVerificationJob({}, db.pool);
      expect(first?.runId).toBe("run_job_stale_claim");
      await db.pool.query(
        `update verification_jobs
            set locked_at = now() - interval '11 minutes',
                not_before = now() - interval '1 minute'
          where id = $1`,
        [first!.id],
      );
      const second = await claimNextVerificationJob({}, db.pool);
      expect(second?.attempts).toBe(first!.attempts + 1);

      await applyVerificationResult(
        "run_job_stale_claim",
        {
          summary: { ...validSummary, avgFps: 333 },
          runStatus: "flagged",
          signatureValid: null,
          diagnostics: [],
          capabilityManifest: null,
          methodologyManifest: null,
          generatedFrameTech: "none",
        },
        first!,
        db.pool,
      );
      expect((await readRun("run_job_stale_claim", db.pool))?.summary.avgFps).toBe(
        validSummary.avgFps,
      );

      await applyVerificationResult(
        "run_job_stale_claim",
        {
          summary: validSummary,
          runStatus: "validated",
          signatureValid: null,
          diagnostics: [],
          capabilityManifest: null,
          methodologyManifest: null,
          generatedFrameTech: "none",
        },
        second!,
        db.pool,
      );
      expect(await completeVerificationJob(second!.id, second!.attempts, db.pool)).toBe(true);
      expect(
        await failVerificationJob(first!.id, first!.attempts, "late worker", true, db.pool),
      ).toBe(false);

      expect((await readRun("run_job_stale_claim", db.pool))?.status).toBe(RUN_STATUS.validated);
      expect(
        (await db.pool.query("select status from verification_jobs where id = $1", [first!.id])).rows,
      ).toEqual([{ status: "succeeded" }]);
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

  describe("benchmark-set repeatability (§16c.2/§16c.3)", () => {
    it("pools only the same scoped public profile and never leaks private members", async () => {
      const benchmarkSetId = "3d9fb878-cb0d-4cc8-9ac8-e9ec97ea977a";
      const benchmarkSetSecretHash = tokenHashFor("benchmark-set-repeatability");
      const makeSetRun = (
        id: string,
        avgFps: number,
        {
          isWarmup = false,
          visibility = RUN_VISIBILITY.public,
          status = RUN_STATUS.validated,
          vsync = false,
          setId = benchmarkSetId,
        }: {
          isWarmup?: boolean;
          visibility?: Run["visibility"];
          status?: Run["status"];
          vsync?: boolean;
          setId?: string;
        } = {},
      ): Run => ({
        ...validRun,
        id,
        visibility,
        status,
        summary: { ...validRun.summary, avgFps },
        framesObjectKey: `runs/${id}.parquet`,
        benchmarkSetId: setId,
        ...(isWarmup ? { isWarmup: true } : {}),
        methodologyManifest: {
          version: 1,
          sceneType: "benchmark-scene",
          resolution: "2560x1440",
          upscaler: "none",
          rayTracing: "off",
          frameGeneration: "none",
          framePacing: { vsync, vrr: false },
        },
      });

      const primary = makeSetRun("run_set_primary", 100);
      await Promise.all([
        insertRun(primary, db.pool, { benchmarkSetSecretHash }),
        insertRun(makeSetRun("run_set_peer", 101), db.pool, { benchmarkSetSecretHash }),
        insertRun(makeSetRun("run_set_warmup", 250, { isWarmup: true }), db.pool, {
          benchmarkSetSecretHash,
        }),
        insertRun(makeSetRun("run_set_other_profile", 40, { vsync: true }), db.pool, {
          benchmarkSetSecretHash,
        }),
        insertRun(makeSetRun("run_set_private", 40, { visibility: RUN_VISIBILITY.private }), db.pool, {
          benchmarkSetSecretHash,
        }),
        insertRun(makeSetRun("run_set_unlisted", 40, { visibility: RUN_VISIBILITY.unlisted }), db.pool, {
          benchmarkSetSecretHash,
        }),
        insertRun(makeSetRun("run_set_flagged", 40, { status: RUN_STATUS.flagged }), db.pool, {
          benchmarkSetSecretHash,
        }),
        // The user-visible label is intentionally not server data. A different
        // browser that chooses the same words receives another opaque id and
        // cannot pollute this set.
        insertRun(
          makeSetRun("run_set_same_label_other_scope", 999, {
            setId: "8b4f4a96-84f1-45c3-8c1d-ecb4fdd6316b",
          }),
          db.pool,
          { benchmarkSetSecretHash: tokenHashFor("same-display-label-other-browser") },
        ),
      ]);

      const summary = await readVisibleBenchmarkSet(primary, db.pool);
      expect(summary).toMatchObject({
        sampleCount: 2,
        warmupRunCount: 1,
        meanAvgFps: 100.5,
        confidence: "medium",
      });
      expect(summary?.stdDevAvgFps).toBeCloseTo(0.5, 8);
      expect(summary?.coefficientOfVariation).toBeCloseTo(0.5 / 100.5, 8);

      // Direct-link visibility alone is insufficient for cross-run data. Until
      // Phase 8 adds owner authorization, an unlisted source run gets no set
      // summary even if its label happens to match public runs.
      expect(
        await readVisibleBenchmarkSet(
          { ...primary, visibility: RUN_VISIBILITY.unlisted },
          db.pool,
        ),
      ).toBeNull();

      const profileless = {
        ...makeSetRun("run_set_profileless", 100),
        methodologyManifest: undefined,
      };
      await insertRun(profileless, db.pool, { benchmarkSetSecretHash });
      expect(await readVisibleBenchmarkSet(profileless, db.pool)).toBeNull();
    });
  });

  describe("canonical resolution (§11.9)", () => {
    it("suppresses a stale curated driver requirement (§15.4)", async () => {
      const id = "run_driver_requirement_freshness";
      const gameId = await resolveGameId("capframex", "Cyberpunk 2077", db.pool);
      expect(gameId).toBeTruthy();

      await insertRun(pendingRun(id), db.pool);
      expect(
        await finalizeRun(
          {
            id,
            framesObjectKey: `runs/${id}.parquet`,
            stagingCleanup: stagingCleanup(id),
            visibility: RUN_VISIBILITY.unlisted,
            managementTokenHash: null,
            signature: null,
            gameId,
            gpuHardwareId: null,
            cpuHardwareId: null,
          },
          db.pool,
        ),
      ).toBe(true);
      expect(await readRunRequiredDriver(id, db.pool)).toBe("566.36");
      expect((await readRunForVerification(id, db.pool))?.requiredDriver).toBe("566.36");

      await db.pool.query(
        "update games set required_driver_checked_at = now() - interval '31 days' where id = $1",
        [gameId],
      );
      expect(await readRunRequiredDriver(id, db.pool)).toBeNull();
      expect((await readRunForVerification(id, db.pool))?.requiredDriver).toBeNull();
    });

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

    it("keeps same-source CPU and GPU aliases independently addressable", async () => {
      const label = "AMD Ryzen 7 8700G";
      const gpu = await resolveHardwareId("gpu", "capframex", label, "amd", db.pool);
      const cpu = await resolveHardwareId("cpu", "capframex", label, null, db.pool);

      expect(gpu).toBeTruthy();
      expect(cpu).toBeTruthy();
      expect(cpu).not.toBe(gpu);
      expect(await resolveHardwareId("gpu", "capframex", label, "amd", db.pool)).toBe(gpu);
      expect(await resolveHardwareId("cpu", "capframex", label, null, db.pool)).toBe(cpu);

      const aliases = await db.pool.query<{ alias_kind: string; hardware_kind: string }>(
        `select ha.kind as alias_kind, h.kind as hardware_kind
           from hardware_aliases ha
           join hardware h on h.id = ha.hardware_id
          where ha.source = 'capframex'
            and ha.normalized_name = 'amd ryzen 7 8700g'
          order by ha.kind`,
      );
      expect(aliases.rows).toEqual([
        { alias_kind: "cpu", hardware_kind: "cpu" },
        { alias_kind: "gpu", hardware_kind: "gpu" },
      ]);
    });

    it("rejects a second same-kind mapping for one source alias", async () => {
      const label = "AMD Radeon 780M";
      const original = await resolveHardwareId("gpu", "capframex", label, "amd", db.pool);
      expect(original).toBeTruthy();

      const competing = await db.pool.query<{ id: string }>(
        `insert into hardware (kind, vendor, canonical_name)
         values ('gpu', 'amd', 'Competing Radeon 780M')
         returning id`,
      );

      await expect(
        db.pool.query(
          `insert into hardware_aliases (hardware_id, kind, source, raw_name, normalized_name)
           values ($1, $2, $3, $4, $5)`,
          [competing.rows[0]!.id, "gpu", "capframex", label, "amd radeon 780m"],
        ),
      ).rejects.toMatchObject({ code: "23505" });
    });

    it("rejects an alias kind that disagrees with its hardware row", async () => {
      const cpu = await resolveHardwareId(
        "cpu",
        "capframex",
        "AMD Ryzen 5 7600",
        null,
        db.pool,
      );
      expect(cpu).toBeTruthy();

      await expect(
        db.pool.query(
          `insert into hardware_aliases (hardware_id, kind, source, raw_name, normalized_name)
           values ($1, $2, $3, $4, $5)`,
          [cpu, "gpu", "curation", "Mismatched alias", "mismatched alias"],
        ),
      ).rejects.toMatchObject({ code: "23503" });
    });

    it("returns null (non-fatal) for blank names", async () => {
      expect(await resolveGameId("user", "   ", db.pool)).toBeNull();
      expect(await resolveHardwareId("cpu", "user", " ™ ", null, db.pool)).toBeNull();
    });
  });
});
