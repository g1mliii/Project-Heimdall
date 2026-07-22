/**
 * Verification-job queue repository (§11.5) over the `verification_jobs`
 * table (0003). Claims use FOR UPDATE SKIP LOCKED against the partial active
 * queue index. A claim writes its lease deadline into `not_before`, so pending
 * retries and stale running work share one ordered, indexable eligibility path.
 * Every claim increments `attempts`, so a permanently crashing job
 * self-terminates at the cap (enforced by the caller via
 * `failVerificationJob(..., terminal)`).
 */

import {
  DIAGNOSTICS_RULE_GENERATION,
  RUN_STATUS,
  writableRunStatusSql,
  type CapabilityManifest,
  type DiagnosticFinding,
  type GeneratedFrameTech,
  type MethodologyManifest,
  type RunSummary,
} from "@heimdall/shared";
import {
  query,
  getPool,
  diagnosticInsertColumns,
  diagnosticInsertSql,
  RETRY_BACKOFF_SECS_SQL,
  summaryColumns,
  summaryUpdateSql,
  type Queryable,
} from "../db";

export type { DiagnosticFinding } from "@heimdall/shared";

export interface ClaimedJob {
  /** bigint — comes back from pg as a string. */
  id: string;
  runId: string;
  /** Attempt number INCLUDING this claim. */
  attempts: number;
}

/** Canonical worker output committed together after a successful verification. */
export interface VerificationResult {
  summary: RunSummary;
  runStatus: "validated" | "flagged";
  signatureValid: boolean | null;
  diagnostics: readonly DiagnosticFinding[];
  capabilityManifest: CapabilityManifest | null;
  methodologyManifest: MethodologyManifest | null;
  generatedFrameTech: GeneratedFrameTech;
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
                else now() + make_interval(secs => ${RETRY_BACKOFF_SECS_SQL})
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
  result: VerificationResult,
  claim: Pick<ClaimedJob, "id" | "attempts">,
  db: Queryable = getPool(),
): Promise<void> {
  // `writableRunStatusSql()` — a deletion tombstone or a §20.5
  // moderation takedown outranks a late verification verdict; without this
  // guard a queued job would flip either status back to validated/flagged
  // (and, if public, back into aggregate eligibility). Every write (summary,
  // diagnostics) is gated on the same run_update via the CTE, so a run in
  // either state, or a stale job claim, writes nothing.
  //
  // Diagnostics are delete-then-insert per run_id in this one statement, so a
  // job retry replaces the prior run's findings rather than duplicating them
  // (idempotent across the ≤5 attempts). Empty arrays clear findings and insert
  // none — a run that used to warn and no longer does ends clean.
  await db.query(
    `with job_claim as (
        select 1
         from verification_jobs
        where id = $16
          and run_id = $1
          and status = 'running'
          and attempts = $17
     ), run_update as (
       update runs
          set status = $13, signature_valid = $14,
              generated_frame_tech = $15,
              capability_manifest = $18::jsonb,
              capability_manifest_version = ($18::jsonb ->> 'version')::integer,
              settings_json = $19::jsonb,
              methodology_manifest_version = ($19::jsonb ->> 'version')::integer,
              -- These findings were evaluated at the current diagnostics rule
              -- generation, so stamp the §17.8.0 watermark; a freshly verified
              -- run is never re-enqueued by the generation lane.
              diagnostics_rule_generation = ${DIAGNOSTICS_RULE_GENERATION},
              diagnostics_evaluated_at = now()
        where id = $1
          and ${writableRunStatusSql()}
          and exists (select 1 from job_claim)
        returning id
     ), summary_update as (
       ${summaryUpdateSql(1, 2, "exists (select 1 from run_update)")}
     ), diagnostics_delete as (
       delete from diagnostics
        where run_id = $1
          and exists (select 1 from run_update)
     )
     ${diagnosticInsertSql(1, 20, "exists (select 1 from run_update)")}`,
    [
      runId,
      ...summaryColumns(result.summary),
      result.runStatus,
      result.signatureValid,
      result.generatedFrameTech,
      claim.id,
      claim.attempts,
      result.capabilityManifest ? JSON.stringify(result.capabilityManifest) : null,
      result.methodologyManifest ? JSON.stringify(result.methodologyManifest) : null,
      ...diagnosticInsertColumns(result.diagnostics),
    ],
  );
}
