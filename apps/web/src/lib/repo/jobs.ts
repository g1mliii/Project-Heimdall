/**
 * Verification-job queue repository (§11.5) over the `verification_jobs`
 * table (0003). Claims use FOR UPDATE SKIP LOCKED against the partial
 * (pending|running) index from 0006; a `running` row whose lock has gone stale
 * is reclaimable — that IS the stuck-job reaper. Every claim increments
 * `attempts`, so a permanently crashing job self-terminates at the cap
 * (enforced by the caller via `failVerificationJob(..., terminal)`).
 */

import { GENERATED_FRAME_TECH, type RunSummary } from "@heimdall/shared";
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
        set status = 'running', locked_at = now(), attempts = vj.attempts + 1
      where vj.id = (
        select id from verification_jobs
         where (status = 'pending'
            or (status = 'running' and locked_at < now() - make_interval(mins => $1)))
           and id <> all($2::bigint[])
         order by created_at, id
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
  db: Queryable = getPool(),
): Promise<void> {
  await db.query(
    "update verification_jobs set status = 'succeeded', locked_at = null, last_error = null where id = $1",
    [id],
  );
}

/**
 * Put a claimed job back untouched — used when a drain pass re-claims a job
 * it already attempted (retry belongs to a LATER pass, with real backoff, not
 * a tight loop). Undoes the claim's attempt increment.
 */
export async function releaseVerificationJob(
  id: string,
  db: Queryable = getPool(),
): Promise<void> {
  await db.query(
    `update verification_jobs
        set status = 'pending', locked_at = null, attempts = greatest(attempts - 1, 0)
      where id = $1`,
    [id],
  );
}

/**
 * Record a failure. `terminal` sends the job to `failed` (done forever);
 * otherwise it returns to `pending` for a later drain pass to retry.
 */
export async function failVerificationJob(
  id: string,
  error: string,
  terminal: boolean,
  db: Queryable = getPool(),
): Promise<void> {
  await db.query(
    `update verification_jobs
        set status = $2, locked_at = null, last_error = $3
      where id = $1`,
    [id, terminal ? "failed" : "pending", error.slice(0, 2000)],
  );
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
  db: Queryable = getPool(),
): Promise<void> {
  // `status <> 'hidden'` — a moderation takedown outranks a late verification
  // verdict; without the guard a queued job would flip a hidden run back to
  // validated/flagged (and, if public, back into aggregate eligibility). The
  // summary update is gated on the same condition via the CTE.
  await db.query(
    `with run_update as (
       update runs
          set status = $13, signature_valid = $14,
              generated_frame_tech = case
                when generated_frame_tech in ($15, $16)
                  then case when $9 > 0 then $15 else $16 end
                else generated_frame_tech
              end
        where id = $1
          and status <> 'hidden'
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
    ],
  );
}
