/**
 * Durable account erasure (§20.4). A verified Clerk `user.deleted` event
 * immediately tombstones every owned run and queues this worker. Storage
 * deletion then runs in bounded batches from the maintenance pass, so a large
 * account cannot make the webhook time out or leave an unbounded list of R2
 * keys in a Node heap.
 *
 * Ordering remains load-bearing: hidden → R2 → run rows → user row. A failed
 * object deletion leaves its hidden row and durable job in place for retry.
 */

import { RUN_STATUS } from "@heimdall/shared";
import { getPool, query, RETRY_BACKOFF_SECS_SQL, type Queryable } from "../db";
import { accountErasureFenceKey } from "../erasure-fence";
import { deleteObject as deleteR2Object, framesUploadObjectKey } from "../r2";

const ERASURE_BATCH_SIZE = 20;
const ERASURE_DELETE_CONCURRENCY = 4;
const ERASURE_LEASE_MINUTES = 10;

interface OwnedRun {
  id: string;
  framesObjectKey: string | null;
}

interface ClaimedErasureJob {
  userId: string;
  attempts: number;
}

export interface ErasureDrainResult {
  claimed: number;
  completed: number;
  retried: number;
  deletedRuns: number;
}

export interface ErasureDeps {
  db: Queryable;
  deleteObject(key: string): Promise<void>;
}

function realDeps(): ErasureDeps {
  return { db: getPool(), deleteObject: deleteR2Object };
}

/**
 * The sole event-facing entry point. It is one data-modifying statement so a
 * crash cannot tombstone runs without also leaving a durable job to finish
 * their R2 and database cleanup.
 */
async function enqueueUserErasureInternal(
  userId: string,
  db: Queryable,
  svixId: string | null,
): Promise<void> {
  await db.query(
    `with incoming_event as (
       insert into clerk_webhook_events (svix_id, user_id_hash, event_type)
       select $3, $2, 'user.deleted'
        where $3::text is not null
       on conflict (svix_id) do nothing
       returning 1
     ), event_permitted as (
       select 1
        where $3::text is null or exists (select 1 from incoming_event)
     ), fence as (
       insert into account_erasure_tombstones (user_id_hash)
       select $2 from event_permitted
       on conflict (user_id_hash) do nothing
       returning 1
     ), fence_ready as (
       -- Direct/recovery calls may encounter an already-written fence; an
       -- event delivery with an already-seen Svix id must remain a no-op.
       select 1 from event_permitted
        where exists (select 1 from fence)
           or exists (
             select 1 from account_erasure_tombstones where user_id_hash = $2
           )
     ), target_user as (
       -- This row lock conflicts with the FK key-share lock used by a run
       -- insert. Once the fence commits, a late owner write cannot slip between
       -- the first tombstone and the worker's final user delete.
       select id
         from users
        where id = $1
          and exists (select 1 from fence_ready)
        for update
     ), marked as (
       update users
          set erasure_requested_at = coalesce(erasure_requested_at, now())
        where id in (select id from target_user)
        returning id
     ), hidden as (
       update runs
          set status = '${RUN_STATUS.hidden}'
        where user_id in (select id from marked)
          and status <> '${RUN_STATUS.hidden}'
     ), queued as (
       insert into account_erasure_jobs (user_id)
       select id from marked
       on conflict (user_id) do update
         set not_before = case
           when account_erasure_jobs.locked_at is null
             then least(account_erasure_jobs.not_before, now())
           else account_erasure_jobs.not_before
         end
       returning user_id
     )
     select user_id from queued`,
    [userId, accountErasureFenceKey(userId), svixId],
  );
}

export async function enqueueUserErasure(userId: string, db: Queryable = getPool()): Promise<void> {
  await enqueueUserErasureInternal(userId, db, null);
}

/** Webhook-only entry point: Svix idempotency and the deletion fence commit together. */
export async function enqueueUserErasureFromClerk(
  userId: string,
  svixId: string,
  db: Queryable = getPool(),
): Promise<void> {
  await enqueueUserErasureInternal(userId, db, svixId);
}

async function claimNextUserErasureJob(db: Queryable): Promise<ClaimedErasureJob | null> {
  const rows = await query<{ user_id: string; attempts: number }>(
    `update account_erasure_jobs aej
        set locked_at = now(),
            not_before = now() + make_interval(mins => $1),
            attempts = aej.attempts + 1,
            last_attempt_at = now()
      where aej.user_id = (
        select user_id
          from account_erasure_jobs
         where not_before <= now()
         order by not_before, user_id
         for update skip locked
         limit 1
      )
      returning aej.user_id, aej.attempts`,
    [ERASURE_LEASE_MINUTES],
    db,
  );
  const row = rows[0];
  return row ? { userId: row.user_id, attempts: row.attempts } : null;
}

async function releaseUserErasureJob(job: ClaimedErasureJob, db: Queryable): Promise<void> {
  await db.query(
    `update account_erasure_jobs
        set locked_at = null,
            not_before = now()
      where user_id = $1 and attempts = $2 and locked_at is not null`,
    [job.userId, job.attempts],
  );
}

async function retryUserErasureJob(
  job: ClaimedErasureJob,
  error: string,
  db: Queryable,
): Promise<void> {
  await db.query(
    `update account_erasure_jobs
        set locked_at = null,
            not_before = now() + make_interval(secs => ${RETRY_BACKOFF_SECS_SQL}),
            last_error = $2
      where user_id = $1 and attempts = $3 and locked_at is not null`,
    [job.userId, error.slice(0, 2_000), job.attempts],
  );
}

async function listOwnedRunBatch(userId: string, db: Queryable): Promise<OwnedRun[]> {
  const rows = await query<{ id: string; frames_object_key: string | null }>(
    `select id, frames_object_key
       from runs
      where user_id = $1
        and status = $2
      order by id
      limit $3`,
    [userId, RUN_STATUS.hidden, ERASURE_BATCH_SIZE],
    db,
  );
  return rows.map((row) => ({ id: row.id, framesObjectKey: row.frames_object_key }));
}

/** Delete a single bounded batch, leaving any failure durable and retryable. */
async function processUserErasureJob(
  job: ClaimedErasureJob,
  deps: ErasureDeps,
): Promise<{ completed: boolean; retried: boolean; deletedRuns: number }> {
  // A just-expired session can theoretically finish an upload after the
  // webhook's first tombstone. Re-tombstone before every batch so that a
  // late row cannot keep the account job permanently non-empty.
  await deps.db.query(
    `update runs
        set status = $2
      where user_id = $1
        and status <> $2`,
    [job.userId, RUN_STATUS.hidden],
  );
  const runs = await listOwnedRunBatch(job.userId, deps.db);
  if (runs.length === 0) {
    // Deleting the user cascades the now-empty job. No direct job delete is
    // needed, and a duplicate/replayed event remains a harmless no-op.
    const deleted = await deps.db.query(
      "delete from users where id = $1 and erasure_requested_at is not null",
      [job.userId],
    );
    if ((deleted.rowCount ?? 0) > 0) {
      return { completed: true, retried: false, deletedRuns: 0 };
    }
    await releaseUserErasureJob(job, deps.db);
    return { completed: false, retried: false, deletedRuns: 0 };
  }

  const deletedIds: string[] = [];
  let failure: unknown = null;
  for (let index = 0; index < runs.length; index += ERASURE_DELETE_CONCURRENCY) {
    const group = runs.slice(index, index + ERASURE_DELETE_CONCURRENCY);
    const outcomes = await Promise.allSettled(
      group.map(async (run) => {
        // Pending uploads always use this deterministic staging key, even
        // though `frames_object_key` is still null. Finalization may also
        // leave a staging copy behind after a failed cleanup attempt. Delete
        // both before the row so the cascading staging-cleanup-job delete
        // cannot orphan either object.
        await deps.deleteObject(framesUploadObjectKey(run.id));
        if (run.framesObjectKey) await deps.deleteObject(run.framesObjectKey);
        return run.id;
      }),
    );
    for (const outcome of outcomes) {
      if (outcome.status === "fulfilled") {
        deletedIds.push(outcome.value);
      } else {
        failure ??= outcome.reason;
      }
    }
  }

  if (deletedIds.length > 0) {
    await deps.db.query(
      `delete from runs
        where id = any($1::text[])
          and user_id = $2
          and status = $3`,
      [deletedIds, job.userId, RUN_STATUS.hidden],
    );
  }
  if (failure !== null) {
    await retryUserErasureJob(job, String(failure), deps.db);
    return { completed: false, retried: true, deletedRuns: deletedIds.length };
  }

  if (runs.length < ERASURE_BATCH_SIZE) {
    const deleted = await deps.db.query(
      `delete from users
        where id = $1
          and erasure_requested_at is not null
          and not exists (select 1 from runs where user_id = $1)`,
      [job.userId],
    );
    if ((deleted.rowCount ?? 0) > 0) {
      return { completed: true, retried: false, deletedRuns: deletedIds.length };
    }
    await releaseUserErasureJob(job, deps.db);
    return { completed: false, retried: false, deletedRuns: deletedIds.length };
  }
  await releaseUserErasureJob(job, deps.db);
  return { completed: false, retried: false, deletedRuns: deletedIds.length };
}

export async function drainUserErasures(
  { maxJobs = 2, deadlineAt }: { maxJobs?: number; deadlineAt?: number } = {},
  deps: ErasureDeps = realDeps(),
): Promise<ErasureDrainResult> {
  const result: ErasureDrainResult = { claimed: 0, completed: 0, retried: 0, deletedRuns: 0 };
  while (result.claimed < maxJobs && (deadlineAt === undefined || Date.now() < deadlineAt)) {
    const job = await claimNextUserErasureJob(deps.db);
    if (!job) break;
    result.claimed += 1;
    try {
      const outcome = await processUserErasureJob(job, deps);
      result.deletedRuns += outcome.deletedRuns;
      if (outcome.completed) result.completed += 1;
      if (outcome.retried) result.retried += 1;
    } catch (error) {
      await retryUserErasureJob(job, String(error), deps.db);
      result.retried += 1;
    }
  }
  return result;
}
