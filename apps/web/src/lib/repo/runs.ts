/**
 * Run lifecycle repository — finalize, delete-token lookups, stale-pending
 * reaping (Phase 4 §11.4/§11.11). Narrow selects on purpose: the management
 * token hash and signature never ride the general read path (`readRun`).
 */

import { RUN_STATUS, RUN_VISIBILITY } from "@heimdall/shared";
import type { Run } from "@heimdall/shared";
import { query, getPool, readRun, type Queryable } from "../db";

/**
 * Pre-auth read gate shared by GET /api/runs/:id and GET /api/runs/:id/frames:
 * missing, private, and hidden are indistinguishable (all null → 404) so a
 * probe can't confirm a private run exists. Ownership arrives in Phase 8 —
 * keep the gate HERE so both routes change together.
 */
export async function readVisibleRun(id: string, db: Queryable = getPool()): Promise<Run | null> {
  const run = await readRun(id, db);
  if (!run || run.visibility === RUN_VISIBILITY.private || run.status === RUN_STATUS.hidden) {
    return null;
  }
  return run;
}

export interface FinalizeRunParams {
  id: string;
  framesObjectKey: string;
  visibility: string;
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
     )
     insert into verification_jobs (run_id)
     select id from updated
     returning run_id`,
    [
      params.id,
      params.framesObjectKey,
      params.visibility,
      params.managementTokenHash,
      params.signature,
      params.gameId,
      params.gpuHardwareId,
      params.cpuHardwareId,
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
 * Stale unfinalized runs for the §11.11 TTL reaper. `frames_object_key is
 * null` scopes this to never-finalized rows — the uploaded-but-unfinalized R2
 * object is still covered because the object key is deterministic
 * (`runs/{id}.parquet`), so the reaper deletes it blind.
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
