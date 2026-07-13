/**
 * Run lifecycle repository — finalize, delete-token lookups, stale-pending
 * reaping (Phase 4 §11.4/§11.11). Narrow selects on purpose: the management
 * token hash and signature never ride the general read path (`readRun`).
 */

import { benchmarkSetConfidence } from "@heimdall/parsers";
import type { BenchmarkSetStats } from "@heimdall/parsers";
import {
  aggregateEligibilitySql,
  comparabilityMatchSql,
  comparabilityProfileSql,
  isAggregateEligible,
  RUN_STATUS,
  RUN_VISIBILITY,
} from "@heimdall/shared";
import type { Run } from "@heimdall/shared";
import { query, getPool, readDiagnostics, readRun, type Queryable } from "../db";

function isPreAuthVisible(run: Pick<Run, "visibility" | "status">): boolean {
  return (
    run.visibility !== RUN_VISIBILITY.private &&
    run.status !== RUN_STATUS.flagged &&
    run.status !== RUN_STATUS.hidden
  );
}

/**
 * Pre-auth read gate shared by GET /api/runs/:id and GET /api/runs/:id/frames:
 * missing, private, flagged, and hidden are indistinguishable (all null → 404) so a
 * probe can't confirm a private run exists. Ownership arrives in Phase 8 —
 * keep the gate HERE so both routes change together.
 */
export async function readVisibleRun(
  id: string,
  db: Queryable = getPool(),
  { withDiagnostics = true }: { withDiagnostics?: boolean } = {},
): Promise<Run | null> {
  // Gate before reading findings: private/flagged/hidden probes must not pay
  // for a diagnostics query they can never observe.
  const run = await readRun(id, db, { withDiagnostics: false });
  if (!run || !isPreAuthVisible(run)) {
    return null;
  }
  return withDiagnostics ? { ...run, diagnostics: await readDiagnostics(id, db) } : run;
}

/** Minimal pre-auth frame-read gate: the chart needs no summary or diagnostics. */
export async function readVisibleFramesState(
  id: string,
  db: Queryable = getPool(),
): Promise<{ framesObjectKey: string | null } | null> {
  const rows = await query<{
    visibility: Run["visibility"];
    status: Run["status"];
    frames_object_key: string | null;
  }>(
    `select visibility, status, frames_object_key
       from runs
      where id = $1`,
    [id],
    db,
  );
  const row = rows[0];
  if (!row || !isPreAuthVisible(row)) {
    return null;
  }
  return { framesObjectKey: row.frames_object_key };
}

interface BenchmarkSetAggregateRow {
  sample_count: number | string;
  warmup_run_count: number | string;
  mean_avg_fps: number | string;
  stddev_avg_fps: number | string;
}

/**
 * Read the repeatability summary for a public report's benchmark set (§16c.2).
 *
 * This is deliberately stricter than the direct-link run gate: benchmark-set
 * membership can reveal another run's performance, so only public + validated
 * members in the exact same declared methodology/comparability bucket
 * participate. The database returns aggregate counts/statistics only — never a
 * member id or individual FPS value. Owner-aware private-set views arrive with
 * Phase 8 authorization.
 */
export async function readVisibleBenchmarkSet(
  run: Run,
  db: Queryable = getPool(),
): Promise<BenchmarkSetStats | null> {
  if (!run.benchmarkSetId || !isAggregateEligible(run)) {
    return null;
  }

  const rows = await query<BenchmarkSetAggregateRow>(
    `with base as (
       select game_id, gpu_hardware_id, resolution, upscaler, ray_tracing,
              generated_frame_tech, graphics_api, frame_pacing_cap, vsync, vrr, scene_type
         from runs base
        where base.id = $2
          and base.benchmark_set_id = $1
          and ${aggregateEligibilitySql("base")}
          and ${comparabilityProfileSql("base")}
     )
     select count(*) filter (where not r.is_warmup) as sample_count,
            count(*) filter (where r.is_warmup) as warmup_run_count,
            coalesce(avg(s.avg_fps) filter (where not r.is_warmup), 0)::double precision
              as mean_avg_fps,
            coalesce(stddev_pop(s.avg_fps) filter (where not r.is_warmup), 0)::double precision
              as stddev_avg_fps
       from base
       join runs r on r.benchmark_set_id = $1
         and ${comparabilityMatchSql("r", "base")}
       join run_summaries s on s.run_id = r.id
      where ${aggregateEligibilitySql("r")}
        and ${comparabilityProfileSql("r")}`,
    [run.benchmarkSetId, run.id],
    db,
  );
  const row = rows[0];
  if (!row) {
    return null;
  }
  const sampleCount = Number(row.sample_count);
  const warmupRunCount = Number(row.warmup_run_count);
  if (sampleCount + warmupRunCount === 0) return null;

  const meanAvgFps = Number(row.mean_avg_fps);
  const stdDevAvgFps = Number(row.stddev_avg_fps);
  const coefficientOfVariation = sampleCount > 0 && meanAvgFps > 0 ? stdDevAvgFps / meanAvgFps : 0;
  return {
    sampleCount,
    warmupRunCount,
    meanAvgFps,
    stdDevAvgFps,
    coefficientOfVariation,
    confidence: benchmarkSetConfidence(sampleCount, coefficientOfVariation),
  };
}

export interface FinalizeRunParams {
  id: string;
  framesObjectKey: string;
  /** Durable post-expiry cleanup for the browser-writable staging object. */
  stagingCleanup: { objectKey: string; notBefore: Date };
  visibility: Run["visibility"];
  managementTokenHash: string | null;
  signature: string | null;
  gameId: string | null;
  gpuHardwareId: string | null;
  cpuHardwareId: string | null;
}

/**
 * Finalize a pending run and enqueue its verification job ATOMICALLY — one
 * data-modifying CTE is the transactional outbox (§11.5: durability comes from
 * this row, not from any in-process promise). Returns false when the run is
 * missing or was already finalized (the guard `status = 'pending' and
 * frames_object_key is null` makes re-finalize a no-op, §12.3).
 */
export async function finalizeRun(
  params: FinalizeRunParams,
  db: Queryable = getPool(),
): Promise<boolean> {
  const rows = await query<{ run_id: string }>(
    `with updated as (
       update runs
          set frames_object_key = $2,
              visibility = $3,
              anonymous_management_token_hash = $4,
              signature = $5,
              game_id = $6::bigint,
              gpu_hardware_id = $7::bigint,
              cpu_hardware_id = $8::bigint
        where id = $1
          and status = 'pending'
          and frames_object_key is null
        returning id
     ), verification as (
       insert into verification_jobs (run_id)
       select id from updated
       returning run_id
     ), staging_cleanup as (
       insert into staging_cleanup_jobs (run_id, object_key, not_before)
       select id, $9, $10
         from updated
     )
     select run_id from verification`,
    [
      params.id,
      params.framesObjectKey,
      params.visibility,
      params.managementTokenHash,
      params.signature,
      params.gameId,
      params.gpuHardwareId,
      params.cpuHardwareId,
      params.stagingCleanup.objectKey,
      params.stagingCleanup.notBefore,
    ],
    db,
  );
  return rows.length > 0;
}

/** Just enough state to disambiguate finalize failures (404 vs 409). */
export async function readRunFinalizeState(
  id: string,
  db: Queryable = getPool(),
): Promise<{ status: string; framesObjectKey: string | null } | null> {
  const rows = await query<{ status: string; frames_object_key: string | null }>(
    "select status, frames_object_key from runs where id = $1",
    [id],
    db,
  );
  const row = rows[0];
  return row ? { status: row.status, framesObjectKey: row.frames_object_key } : null;
}

/**
 * Token-verification read for DELETE /api/runs/:id. Deliberately the ONLY
 * place the stored hash is selected.
 */
export async function readRunManagementTokenHash(
  id: string,
  db: Queryable = getPool(),
): Promise<{ tokenHash: string | null; framesObjectKey: string | null } | null> {
  const rows = await query<{
    anonymous_management_token_hash: string | null;
    frames_object_key: string | null;
  }>(
    "select anonymous_management_token_hash, frames_object_key from runs where id = $1",
    [id],
    db,
  );
  const row = rows[0];
  return row
    ? { tokenHash: row.anonymous_management_token_hash, framesObjectKey: row.frames_object_key }
    : null;
}

/** Worker-side read: the stored signature evidence for §11.7 verification. */
export async function readRunSignature(
  id: string,
  db: Queryable = getPool(),
): Promise<{ signature: string | null; framesObjectKey: string | null } | null> {
  const rows = await query<{ signature: string | null; frames_object_key: string | null }>(
    "select signature, frames_object_key from runs where id = $1",
    [id],
    db,
  );
  const row = rows[0];
  return row ? { signature: row.signature, framesObjectKey: row.frames_object_key } : null;
}

/** Delete a run row; summaries/diagnostics/jobs go with it via FK cascade. */
export async function deleteRun(id: string, db: Queryable = getPool()): Promise<boolean> {
  const result = await db.query("delete from runs where id = $1", [id]);
  return (result.rowCount ?? 0) > 0;
}

/**
 * Hide a run before its immutable frames object is deleted. If storage is
 * temporarily unavailable, the delete-token holder can retry while public
 * readers can no longer be sent to an object that may already be gone.
 */
export async function hideRunForDeletion(id: string, db: Queryable = getPool()): Promise<boolean> {
  const result = await db.query(
    "update runs set status = $2 where id = $1 and status <> $2",
    [id, RUN_STATUS.hidden],
  );
  return (result.rowCount ?? 0) > 0;
}

/**
 * Reaper-only conditional delete. The stale-id read and staging-object delete
 * are intentionally not one database transaction, so finalize may win between
 * them; in that case its row and verification job must survive.
 */
export async function deletePendingRun(id: string, db: Queryable = getPool()): Promise<boolean> {
  const result = await db.query(
    "delete from runs where id = $1 and status = 'pending' and frames_object_key is null",
    [id],
  );
  return (result.rowCount ?? 0) > 0;
}

export interface ClaimedStagingCleanupJob {
  runId: string;
  objectKey: string;
  attempts: number;
}

/**
 * Atomically claim the next due staging cleanup. A claim turns `not_before`
 * into its lease deadline, so due and stale jobs share the existing ordered
 * `(not_before, run_id)` index. The claim generation prevents an older worker
 * from completing or retrying a newer claim.
 */
export async function claimNextStagingCleanupJob(
  { staleLockMinutes = 10 }: { staleLockMinutes?: number } = {},
  db: Queryable = getPool(),
): Promise<ClaimedStagingCleanupJob | null> {
  const rows = await query<{ run_id: string; object_key: string; attempts: number }>(
    `update staging_cleanup_jobs scj
        set locked_at = now(),
            not_before = now() + make_interval(mins => $1),
            attempts = scj.attempts + 1,
            last_attempt_at = now()
      where scj.run_id = (
        select run_id
          from staging_cleanup_jobs
         where not_before <= now()
         order by not_before, run_id
         for update skip locked
         limit 1
      )
      returning scj.run_id, scj.object_key, scj.attempts`,
    [staleLockMinutes],
    db,
  );
  const row = rows[0];
  return row ? { runId: row.run_id, objectKey: row.object_key, attempts: row.attempts } : null;
}

/** Delete only the cleanup job generation this worker claimed. */
export async function completeStagingCleanupJob(
  runId: string,
  attempts: number,
  db: Queryable = getPool(),
): Promise<boolean> {
  const result = await db.query(
    "delete from staging_cleanup_jobs where run_id = $1 and attempts = $2 and locked_at is not null",
    [runId, attempts],
  );
  return (result.rowCount ?? 0) > 0;
}

/** Keep only this claimed cleanup generation durable and back off before retrying. */
export async function retryStagingCleanupJob(
  runId: string,
  attempts: number,
  error: string,
  db: Queryable = getPool(),
): Promise<void> {
  await db.query(
    `update staging_cleanup_jobs
        set last_error = $2,
            locked_at = null,
            not_before = now() + interval '5 minutes'
      where run_id = $1
        and attempts = $3
        and locked_at is not null`,
    [runId, error.slice(0, 2000), attempts],
  );
}

/**
 * Stale unfinalized runs for the §11.11 TTL reaper. `frames_object_key is
 * null` scopes this to never-finalized rows — the uploaded-but-unfinalized R2
 * staging object is still covered because its key is deterministic
 * (`staging/runs/{id}.parquet`), so the reaper deletes it blind.
 */
export async function readStalePendingRuns(
  ttlHours: number,
  limit: number,
  db: Queryable = getPool(),
): Promise<string[]> {
  const rows = await query<{ id: string }>(
    `select id from runs
      where status = 'pending'
        and frames_object_key is null
        and created_at < now() - make_interval(hours => $1)
      order by created_at
      limit $2`,
    [ttlHours, limit],
    db,
  );
  return rows.map((row) => row.id);
}
