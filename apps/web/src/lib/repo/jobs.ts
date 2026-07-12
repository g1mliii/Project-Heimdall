/**
 * Verification-job queue repository (§11.5) over the `verification_jobs`
 * table (0003). Claims use FOR UPDATE SKIP LOCKED against the partial active
 * queue index. A claim writes its lease deadline into `not_before`, so pending
 * retries and stale running work share one ordered, indexable eligibility path.
 * Every claim increments `attempts`, so a permanently crashing job
 * self-terminates at the cap (enforced by the caller via
 * `failVerificationJob(..., terminal)`).
 */

import { GENERATED_FRAME_TECH, RUN_STATUS, type RunSummary } from "@heimdall/shared";
import { query, getPool, type Queryable } from "../db";

export interface ClaimedJob {
  /** bigint — comes back from pg as a string. */
  id: string;
  runId: string;
  /** Attempt number INCLUDING this claim. */
  attempts: number;
}

export async function claimNextVerificationJob(
  {
    staleRunningMinutes = 10,
    excludeIds = [],
  }: {
    staleRunningMinutes?: number;
    /** Job ids to skip — lets a drain pass move past a job it already retried. */
    excludeIds?: string[];
  } = {},
  db: Queryable = getPool(),
): Promise<ClaimedJob | null> {
  const rows = await query<{ id: string; run_id: string; attempts: number }>(
    `update verification_jobs vj
        set status = 'running',
            locked_at = now(),
            not_before = now() + make_interval(mins => $1),
            attempts = vj.attempts + 1
      where vj.id = (
        select id from verification_jobs
         where status in ('pending', 'running')
           and not_before <= now()
           and id <> all($2::bigint[])
         order by not_before, created_at, id
         for update skip locked
         limit 1
      )
      returning vj.id, vj.run_id, vj.attempts`,
    [staleRunningMinutes, excludeIds],
    db,
  );
  const row = rows[0];
  return row ? { id: row.id, runId: row.run_id, attempts: row.attempts } : null;
}

export async function completeVerificationJob(
  id: string,
  attempts: number,
  db: Queryable = getPool(),
): Promise<boolean> {
  const result = await db.query(
    `update verification_jobs
        set status = 'succeeded', locked_at = null, last_error = null
      where id = $1
        and status = 'running'
        and attempts = $2`,
    [id, attempts],
  );
  return (result.rowCount ?? 0) > 0;
}

/**
 * Put a claimed job back untouched — used when a drain pass re-claims a job
 * it already attempted (retry belongs to a LATER pass, with real backoff, not
 * a tight loop). Undoes the claim's attempt increment and clears its lease so
 * another pass can claim it immediately.
 */
export async function releaseVerificationJob(
  id: string,
  attempts: number,
  db: Queryable = getPool(),
): Promise<boolean> {
  const result = await db.query(
    `update verification_jobs
        set status = 'pending',
            locked_at = null,
            not_before = now(),
            attempts = greatest(attempts - 1, 0)
      where id = $1
        and status = 'running'
        and attempts = $2`,
    [id, attempts],
  );
  return (result.rowCount ?? 0) > 0;
}

/**
 * Record a failure. Terminal failures atomically flag their finalized pending
 * run, making provisional data non-public; retryable failures stay pending.
 */
export async function failVerificationJob(
  id: string,
  attempts: number,
  error: string,
  terminal: boolean,
  db: Queryable = getPool(),
): Promise<boolean> {
  const rows = await query<{ updated: boolean }>(
    `with job_update as (
       update verification_jobs
          set status = $2,
              locked_at = null,
              last_error = $3,
              not_before = case
                when $6::boolean then now()
                else now() + make_interval(
                  secs => least(300, 30 * (1 << least(attempts - 1, 4)))
                )
              end
        where id = $1
          and status = 'running'
          and attempts = $4
        returning run_id
     ), run_update as (
     update runs
        set status = $5
       from job_update
      where $6::boolean
        and runs.id = job_update.run_id
        and runs.status = $7
        and runs.frames_object_key is not null
     )
     select exists (select 1 from job_update) as updated`,
    [
      id,
      terminal ? "failed" : "pending",
      error.slice(0, 2000),
      attempts,
      RUN_STATUS.flagged,
      terminal,
      RUN_STATUS.pending,
    ],
    db,
  );
  return rows[0]?.updated ?? false;
}

/**
 * Persist the worker's recompute as canonical (§11.5): overwrite the stored
 * summary IN PLACE and move the run to its post-verification status — one CTE,
 * atomically. "Corrected and flagged" (§12.4) is exactly this call with
 * status='flagged'.
 */
export async function applyVerificationResult(
  runId: string,
  summary: RunSummary,
  runStatus: "validated" | "flagged",
  signatureValid: boolean | null,
  claim: Pick<ClaimedJob, "id" | "attempts">,
  db: Queryable = getPool(),
): Promise<void> {
  // `status <> 'hidden'` — a moderation takedown outranks a late verification
  // verdict; without the guard a queued job would flip a hidden run back to
  // validated/flagged (and, if public, back into aggregate eligibility). The
  // summary update is gated on the same condition via the CTE.
  await db.query(
    `with job_claim as (
       select 1
         from verification_jobs
        where id = $17
          and run_id = $1
          and status = 'running'
          and attempts = $18
     ), run_update as (
       update runs
          set status = $13, signature_valid = $14,
              generated_frame_tech = case
                when $9::double precision = 0 then $16
                when generated_frame_tech in ($15, $16) then $15
                else generated_frame_tech
              end
        where id = $1
          and status <> 'hidden'
          and exists (select 1 from job_claim)
        returning id
     )
     update run_summaries
        set avg_fps = $2, p1_low_fps = $3, p01_low_fps = $4,
            frametime_p50_ms = $5, frametime_p95_ms = $6, frametime_p99_ms = $7,
            stutter_count = $8, generated_frame_pct = $9, p01_low_confidence = $10,
            sample_count = $11, duration_seconds = $12
      where run_id = $1
        and exists (select 1 from run_update)`,
    [
      runId,
      summary.avgFps,
      summary.onePercentLowFps,
      summary.pointOnePercentLowFps,
      summary.frameTimeP50Ms,
      summary.frameTimeP95Ms,
      summary.frameTimeP99Ms,
      summary.stutterCount,
      summary.generatedFramePct,
      summary.pointOnePercentLowConfidence,
      summary.sampleCount,
      summary.durationSeconds,
      runStatus,
      signatureValid,
      GENERATED_FRAME_TECH.unknown,
      GENERATED_FRAME_TECH.none,
      claim.id,
      claim.attempts,
    ],
  );
}
