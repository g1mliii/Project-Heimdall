/**
 * Run lifecycle repository — finalize, delete-token lookups, stale-pending
 * reaping (Phase 4 §11.4/§11.11). Narrow selects on purpose: the management
 * token hash and signature never ride the general read path (`readRun`).
 */

import { benchmarkSetConfidence } from "@heimdall/parsers";
import type { BenchmarkSetStats } from "@heimdall/parsers";
import {
  cohortEligibilitySql,
  comparabilityMatchSql,
  comparabilitySelectSql,
  isAggregateEligible,
  RUN_STATUS,
  RUN_VISIBILITY,
  writableRunStatusSql,
} from "@heimdall/shared";
import type { OwnedRunListItem, Run } from "@heimdall/shared";
import { query, getPool, readDiagnostics, readRun, type Queryable } from "../db";
import type { ViewerIdentity } from "../viewer";

/**
 * The single visibility gate (§20.2c/§20.5), read by every "can this viewer
 * see this run" call site. `hidden` is the deletion tombstone — invisible to
 * everyone, including the owner. `private` is owner-only. `flagged`
 * (integrity) and `moderated` (moderation, §20.5) are both owner-visible —
 * the run's own owner should see why it's hidden — but 404 for everyone
 * else. Everything else (unlisted/public, none of the above) is link-scoped
 * or discoverable, unchanged from the pre-auth model. Keep this the ONLY
 * place that answers this question — the probe-resistance property
 * (missing/private/flagged/moderated/hidden must all read as the same 404)
 * depends on every caller going through here.
 *
 * Takes a `ViewerIdentity` — ownership is a `userId` comparison and nothing
 * here reads `role`, so callers need not pay for a `users` read.
 */
export function isVisibleTo(
  run: Pick<Run, "visibility" | "status" | "ownerId">,
  viewer: ViewerIdentity | null,
): boolean {
  if (run.status === RUN_STATUS.hidden) {
    return false;
  }
  const isOwner = viewer !== null && viewer.userId === run.ownerId;
  if (run.visibility === RUN_VISIBILITY.private) {
    return isOwner;
  }
  if (run.status === RUN_STATUS.flagged || run.status === RUN_STATUS.moderated) {
    return isOwner;
  }
  return true;
}

/**
 * Read gate shared by GET /api/runs/:id and the /runs/:id page: missing,
 * private-to-a-stranger, flagged-to-a-stranger, and hidden are
 * indistinguishable (all null → 404) so a probe can't confirm a run exists.
 */
export async function readVisibleRun(
  id: string,
  viewer: ViewerIdentity | null,
  db: Queryable = getPool(),
  { withDiagnostics = true }: { withDiagnostics?: boolean } = {},
): Promise<Run | null> {
  // Gate before reading findings: a stranger's private/flagged/hidden probe
  // must not pay for a diagnostics query they can never observe.
  const run = await readRun(id, db, { withDiagnostics: false });
  if (!run || !isVisibleTo(run, viewer)) {
    return null;
  }
  return withDiagnostics ? { ...run, diagnostics: await readDiagnostics(id, db) } : run;
}

/** Minimal frame-read gate: the chart needs no summary or diagnostics. */
export async function readVisibleFramesState(
  id: string,
  viewer: ViewerIdentity | null,
  db: Queryable = getPool(),
): Promise<{ framesObjectKey: string | null } | null> {
  const rows = await query<{
    visibility: Run["visibility"];
    status: Run["status"];
    user_id: string | null;
    frames_object_key: string | null;
  }>(
    `select visibility, status, user_id, frames_object_key
       from runs
      where id = $1`,
    [id],
    db,
  );
  const row = rows[0];
  if (!row || !isVisibleTo({ visibility: row.visibility, status: row.status, ownerId: row.user_id ?? undefined }, viewer)) {
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
 * member id or individual FPS value.
 *
 * `viewer` is accepted (matching `readVisibleRun`/`readVisibleFramesState`'s
 * shape) but NOT yet used to relax `isAggregateEligible` for an owner viewing
 * their own private/unlisted run's repeatability panel — doing that safely
 * means loosening `cohortEligibilitySql`'s `base` requirement, which is
 * exactly the "never re-derive the aggregate guard" invariant (AGENTS.md).
 * That's a product decision (does an owner's own-set view bypass the
 * public+validated math?), not an implementation detail — deferred until
 * it's made explicitly, rather than guessed at here.
 */
export async function readVisibleBenchmarkSet(
  run: Run,
  _viewer: ViewerIdentity | null,
  db: Queryable = getPool(),
): Promise<BenchmarkSetStats | null> {
  if (!run.benchmarkSetId || !isAggregateEligible(run)) {
    return null;
  }

  const rows = await query<BenchmarkSetAggregateRow>(
    `with base as (
       select ${comparabilitySelectSql("base")}
         from runs base
        where base.id = $2
          and base.benchmark_set_id = $1
          and ${cohortEligibilitySql("base", {
            allowWarmups: true,
            allowBenchmarkSetMembers: true,
            // A run's own repeatability panel is not a public cohort. Requiring
            // the current manifest version here would blank the card for every
            // legacy run until an operator ran the CLI-only full lane.
            requireCurrentCapabilityManifest: false,
          })}
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
      where ${cohortEligibilitySql("r", {
        allowWarmups: true,
        allowBenchmarkSetMembers: true,
        // Must match the `base` CTE: gating members on the manifest version
        // would drop legacy repeats from their own set's count and variance.
        requireCurrentCapabilityManifest: false,
      })}`,
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
 * Token-verification + ownership read for DELETE /api/runs/:id. Deliberately
 * the ONLY place the stored hash is selected.
 */
export async function readRunManagementTokenHash(
  id: string,
  db: Queryable = getPool(),
): Promise<{
  tokenHash: string | null;
  framesObjectKey: string | null;
  ownerId: string | null;
} | null> {
  const rows = await query<{
    anonymous_management_token_hash: string | null;
    frames_object_key: string | null;
    user_id: string | null;
  }>(
    "select anonymous_management_token_hash, frames_object_key, user_id from runs where id = $1",
    [id],
    db,
  );
  const row = rows[0];
  return row
    ? {
        tokenHash: row.anonymous_management_token_hash,
        framesObjectKey: row.frames_object_key,
        ownerId: row.user_id,
      }
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
 * Authorization-aware delete tombstone. The authorization predicate is part
 * of the UPDATE rather than a preceding read, so a claim that clears a token
 * cannot race an already-authorized token delete into removing the new
 * owner's run. A pre-existing `hidden` row is deliberately retryable after an
 * R2 deletion failure.
 */
export async function hideAuthorizedRunForDeletion(
  id: string,
  authorization: { ownerId: string | null; tokenHash: string | null; isAdmin: boolean },
  db: Queryable = getPool(),
): Promise<{ framesObjectKey: string | null } | null> {
  const rows = await query<{ frames_object_key: string | null }>(
    `update runs
        set status = $2
      where id = $1
        and (
          $3::boolean
          or ($4::text is not null and user_id = $4::text)
          or ($5::text is not null and anonymous_management_token_hash = $5::text)
        )
      returning frames_object_key`,
    [id, RUN_STATUS.hidden, authorization.isAdmin, authorization.ownerId, authorization.tokenHash],
    db,
  );
  const row = rows[0];
  return row ? { framesObjectKey: row.frames_object_key } : null;
}

/**
 * Set-wise {@link hideRunForDeletion} / {@link deleteRun} for the account
 * erasure cascade (§20.4), which would otherwise pay a round trip per run.
 * The tombstone-before-R2, rows-after-R2 ordering the cascade depends on holds
 * exactly as it does per run — it just applies to the whole set at once.
 */
export async function hideRunsForDeletion(ids: string[], db: Queryable = getPool()): Promise<void> {
  if (ids.length === 0) return;
  await db.query("update runs set status = $2 where id = any($1::text[]) and status <> $2", [
    ids,
    RUN_STATUS.hidden,
  ]);
}

export async function deleteRuns(ids: string[], db: Queryable = getPool()): Promise<void> {
  if (ids.length === 0) return;
  await db.query("delete from runs where id = any($1::text[])", [ids]);
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

/**
 * Attach an anonymous run to a signed-in account (§20.2e — POST
 * /api/runs/:id/claim). One atomic conditional UPDATE, not a read-then-write:
 * it only succeeds if the run is still ownerless AND its management-token
 * hash still matches what the caller already proved knowledge of (the
 * constant-time comparison happens at the call site, against the hash read
 * moments earlier — this WHERE clause is an optimistic-concurrency guard
 * against a second claim racing in between, not the security check itself).
 * The token is single-purpose: a successful claim clears the hash, so it can
 * never be claimed — or anonymously deleted — again.
 */
export async function claimRun(
  id: string,
  userId: string,
  tokenHash: string,
  db: Queryable = getPool(),
): Promise<boolean> {
  const result = await db.query(
    `update runs
        set user_id = $2,
            anonymous_management_token_hash = null
      where id = $1
        and user_id is null
        and anonymous_management_token_hash = $3
        and ${writableRunStatusSql()}`,
    [id, userId, tokenHash],
  );
  return (result.rowCount ?? 0) > 0;
}

/**
 * Owner-only visibility switch (§20.2 — PATCH /api/runs/:id). `status` is
 * untouched: flipping to `public` does not itself grant aggregate
 * eligibility — that still requires `validated`, unchanged and enforced
 * solely by `isAggregateEligible`/`aggregateEligibilitySql`.
 */
export async function updateRunVisibility(
  id: string,
  visibility: Run["visibility"],
  db: Queryable = getPool(),
): Promise<boolean> {
  const result = await db.query(
    `update runs set visibility = $2
      where id = $1 and ${writableRunStatusSql()}`,
    [id, visibility],
  );
  return (result.rowCount ?? 0) > 0;
}

/**
 * "My runs" for the account page / `GET /api/account/runs` (§20.2). Rides
 * the covering index `runs_user_id_idx (user_id, created_at desc, id desc)`
 * (migration 0006). `hidden` (the deletion tombstone) is excluded — from the
 * owner's own perspective that run is gone, not just invisible to others.
 *
 * Uses a stable created-at/id seek cursor. An owner can always reach an older
 * run to delete it; a high-volume account never turns this management read
 * into an unbounded response or OFFSET scan.
 */
const OWNED_RUNS_PAGE_SIZE = 50;

export interface OwnedRunsPage {
  runs: OwnedRunListItem[];
  nextCursor: string | null;
}

export class InvalidOwnedRunsCursorError extends Error {
  constructor() {
    super("invalid account runs cursor");
    this.name = "InvalidOwnedRunsCursorError";
  }
}

interface OwnedRunsCursor {
  createdAt: string;
  id: string;
}

function encodeOwnedRunsCursor(row: { created_at: string; id: string }): string {
  return Buffer.from(JSON.stringify([new Date(row.created_at).toISOString(), row.id]), "utf8").toString(
    "base64url",
  );
}

function decodeOwnedRunsCursor(cursor: string | null | undefined): OwnedRunsCursor | null {
  if (cursor === null || cursor === undefined) return null;
  try {
    const value: unknown = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    if (
      !Array.isArray(value) ||
      value.length !== 2 ||
      typeof value[0] !== "string" ||
      Number.isNaN(Date.parse(value[0])) ||
      typeof value[1] !== "string" ||
      value[1].length === 0
    ) {
      throw new Error("invalid cursor shape");
    }
    return { createdAt: value[0], id: value[1] };
  } catch {
    throw new InvalidOwnedRunsCursorError();
  }
}

export async function listRunsForUser(
  userId: string,
  db: Queryable = getPool(),
  { cursor, limit = OWNED_RUNS_PAGE_SIZE }: { cursor?: string | null; limit?: number } = {},
): Promise<OwnedRunsPage> {
  const decoded = decodeOwnedRunsCursor(cursor);
  const pageSize = Math.max(1, Math.min(limit, OWNED_RUNS_PAGE_SIZE));
  const rows = await query<{
    id: string;
    game_raw: string;
    visibility: Run["visibility"];
    status: Run["status"];
    created_at: string;
    avg_fps: number | string;
  }>(
    `select r.id, r.game_raw, r.visibility, r.status, r.created_at, s.avg_fps
       from runs r
       join run_summaries s on s.run_id = r.id
      where r.user_id = $1
        and r.status <> '${RUN_STATUS.hidden}'
        and (
          $2::timestamptz is null
          or (r.created_at, r.id) < ($2::timestamptz, $3::text)
        )
      order by r.created_at desc, r.id desc
      limit $4`,
    [userId, decoded?.createdAt ?? null, decoded?.id ?? null, pageSize + 1],
    db,
  );
  const page = rows.slice(0, pageSize);
  const last = page.at(-1);
  return {
    runs: page.map((row) => ({
    id: row.id,
    game: row.game_raw,
    visibility: row.visibility,
    status: row.status,
    createdAt: new Date(row.created_at).toISOString(),
    avgFps: Number(row.avg_fps),
    })),
    nextCursor: rows.length > pageSize && last ? encodeOwnedRunsCursor(last) : null,
  };
}
