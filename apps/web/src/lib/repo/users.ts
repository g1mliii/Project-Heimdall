/**
 * User provisioning (§20.1b). Two write paths share the promote-only admin
 * bootstrap: `ensureUser` is the cheap JIT upsert called when a route needs a
 * guaranteed-present `users` row (id + role only — never touches
 * `handle`/`email` on conflict, so it can't clobber values only the webhook
 * knows); `syncUserFromClerk` is the richer webhook-driven sync that also
 * carries `handle`/`email`.
 *
 * Neither path ever demotes a role: the CSV bootstrap only ever promotes a
 * user already in `CLERK_ADMIN_USER_IDS` up to `admin`, and a role granted via
 * the verified-tier flow (§20.3) is untouched unless the bootstrap list says
 * `admin`.
 *
 * `handle` is OURS, not Clerk's: the webhook may only fill an empty one. See
 * `syncUserFromClerk` for why.
 */

import { getAuthEnv } from "../env";
import { getPool, isUniqueViolation, query, type Queryable } from "../db";
import { accountErasureFenceKey } from "../erasure-fence";
import type { UserRole } from "../viewer";

export type { UserRole };

export interface UserRecord {
  id: string;
  handle: string | null;
  email: string | null;
  role: UserRole;
}

/**
 * A deleted Clerk account can briefly retain a valid browser session and Svix
 * can deliver older profile events after `user.deleted`. Treat both as signed
 * out rather than recreating profile data that the erasure worker removed.
 */
export class AccountErasedError extends Error {
  constructor() {
    super("account has been erased");
    this.name = "AccountErasedError";
  }
}

// provisioned since the last cold start. Safe to lose on redeploy/reload —
// The bootstrap list cannot change within a process, so parse the CSV once
// rather than on every upsert and every webhook sync.
let bootstrapAdmins: Set<string> | null = null;

function isBootstrapAdmin(userId: string): boolean {
  if (!bootstrapAdmins) {
    const { CLERK_ADMIN_USER_IDS } = getAuthEnv();
    bootstrapAdmins = new Set(
      CLERK_ADMIN_USER_IDS.split(",")
        .map((id) => id.trim())
        .filter(Boolean),
    );
  }
  return bootstrapAdmins.has(userId);
}

type UserDbRow = { id: string; handle: string | null; email: string | null; role: string };

function toUserRecord(row: UserDbRow): UserRecord {
  return { id: row.id, handle: row.handle, email: row.email, role: row.role as UserRole };
}

/**
 * The single `users` read. Every surface that needs a `UserRecord` goes
 * through here so the column list and the row mapping can't drift.
 */
export async function readUserRecord(
  userId: string,
  db: Queryable = getPool(),
): Promise<UserRecord | null> {
  const rows = await query<UserDbRow>(
    "select id, handle, email, role from users where id = $1",
    [userId],
    db,
  );
  const row = rows[0];
  return row ? toUserRecord(row) : null;
}

/**
 * Id + promote-only role. Deliberately never writes `handle`/`email`.
 *
 * `returning` (same idiom as `upsertFromClerk` below) makes the write its own
 * read: provisioning a user costs one round trip, not an insert followed by a
 * select.
 */
async function upsertUserRole(userId: string, db: Queryable): Promise<UserRecord> {
  const rows = await query<UserDbRow>(
    `insert into users (id, role)
     select $1, case when $2 then 'admin' else 'public' end
      where not exists (
        select 1 from account_erasure_tombstones where user_id_hash = $3
      )
     on conflict (id) do update
       set role = case when $2 and users.role <> 'admin' then 'admin' else users.role end
     where users.erasure_requested_at is null
     returning id, handle, email, role`,
    [userId, isBootstrapAdmin(userId), accountErasureFenceKey(userId)],
    db,
  );
  const row = rows[0];
  if (!row) {
    throw new AccountErasedError();
  }
  return toUserRecord(row);
}

/**
 * JIT upsert — call this from any route that is about to write a row
 * referencing `users.id` (runs, reports, comparisons), so the FK always has a
 * parent. Read-only routes should use `getViewerIdentity()` instead and skip
 * the round trip entirely (§20.1f).
 */
export async function ensureUser(userId: string, db: Queryable = getPool()): Promise<UserRecord> {
  // One UPSERT/RETURNING round trip is no more expensive than the old memoized
  // SELECT path, and avoids retaining every Clerk id for a long-lived worker.
  return upsertUserRole(userId, db);
}

/**
 * Full sync from a Clerk `user.created`/`user.updated` webhook event.
 *
 * `handle` is ours, not Clerk's: `coalesce(users.handle, excluded.handle)`
 * lets Clerk's username FILL an empty handle but never overwrite one. Two
 * reasons — Clerk instances with the username field disabled always send
 * `username: null`, which would otherwise null out the handle on every
 * unrelated profile edit; and `PATCH /api/account` exists precisely so the
 * handle is user-chosen, so a later Clerk-side rename must not silently
 * revert it (and with it, every submission's public attribution).
 *
 * `email` IS Clerk's and is overwritten on every sync, as documented.
 */
export async function syncUserFromClerk(
  userId: string,
  profile: { handle: string | null; email: string | null },
  db: Queryable = getPool(),
): Promise<UserRecord> {
  try {
    const user = await upsertFromClerk(userId, profile, db);
    if (!user) throw new AccountErasedError();
    return user;
  } catch (error) {
    if (!isUniqueViolation(error, "users_handle_key")) {
      throw error;
    }
    // `users.handle` is unique but Clerk usernames are not drawn from our
    // namespace, so a collision is expected, not exceptional. Sync everything
    // else and leave the handle empty — the user can claim one via
    // `PATCH /api/account`, which reports the 409 properly. Retrying without
    // the handle matters: an uncaught unique violation 500s the webhook, and
    // Svix then retries that event forever without ever provisioning the user.
    const user = await upsertFromClerk(userId, { ...profile, handle: null }, db);
    if (!user) throw new AccountErasedError();
    return user;
  }
}

/**
 * Apply a verified Clerk profile event exactly once. The insert of the Svix
 * id, tombstone check, and profile upsert are one statement, so a duplicate
 * delivery is a no-op and an old `user.updated` cannot recreate an erased
 * account after its deletion fence commits.
 */
export async function syncUserFromClerkEvent(
  event: {
    svixId: string;
    type: "user.created" | "user.updated";
    userId: string;
    profile: { handle: string | null; email: string | null };
  },
  db: Queryable = getPool(),
): Promise<UserRecord | null> {
  try {
    return await upsertFromClerk(event.userId, event.profile, db, {
      svixId: event.svixId,
      eventType: event.type,
    });
  } catch (error) {
    if (!isUniqueViolation(error, "users_handle_key")) {
      throw error;
    }
    return await upsertFromClerk(
      event.userId,
      { ...event.profile, handle: null },
      db,
      { svixId: event.svixId, eventType: event.type },
    );
  }
}

async function upsertFromClerk(
  userId: string,
  profile: { handle: string | null; email: string | null },
  db: Queryable,
  event?: { svixId: string; eventType: "user.created" | "user.updated" },
): Promise<UserRecord | null> {
  const rows = await query<UserDbRow>(
    `with incoming_event as (
       insert into clerk_webhook_events (svix_id, user_id_hash, event_type)
       select $5, $6, $7
        where $5::text is not null
       on conflict (svix_id) do nothing
       returning 1
     ), permitted as (
       select 1
        where not exists (
          select 1 from account_erasure_tombstones where user_id_hash = $6
        )
          and ($5::text is null or exists (select 1 from incoming_event))
     )
     insert into users (id, handle, email, role)
     select $1, $2, $3, case when $4 then 'admin' else 'public' end
       from permitted
     on conflict (id) do update
       set handle = coalesce(users.handle, excluded.handle),
           email = excluded.email,
           role = case when $4 and users.role <> 'admin' then 'admin' else users.role end
     where users.erasure_requested_at is null
     returning id, handle, email, role`,
    [
      userId,
      profile.handle,
      profile.email,
      isBootstrapAdmin(userId),
      event?.svixId ?? null,
      accountErasureFenceKey(userId),
      event?.eventType ?? null,
    ],
    db,
  );
  const row = rows[0];
  return row ? toUserRecord(row) : null;
}

const HANDLE_PATTERN = /^[a-z0-9][a-z0-9-]{2,31}$/;
const RESERVED_HANDLES = new Set([
  "admin",
  "account",
  "api",
  "games",
  "runs",
  "upload",
  "compare",
  "export",
  "privacy",
  "sign-in",
  "sign-up",
  "settings",
  "support",
  "heimdall",
]);

export function isValidHandle(handle: string): boolean {
  return HANDLE_PATTERN.test(handle) && !RESERVED_HANDLES.has(handle);
}

/** `PATCH /api/account` — owner-only handle edit; email stays Clerk-managed. */
export async function updateUserHandle(
  userId: string,
  handle: string,
  db: Queryable = getPool(),
): Promise<UserRecord | null> {
  const rows = await query<UserDbRow>(
    `update users set handle = $2 where id = $1 and erasure_requested_at is null
     returning id, handle, email, role`,
    [userId, handle],
    db,
  );
  const row = rows[0];
  return row ? toUserRecord(row) : null;
}

/**
 * Svix ids are short-lived delivery-deduplication state, not an audit log.
 * Keep a bounded retention window so webhook traffic cannot grow this table
 * indefinitely; the account-erasure fence itself remains separately durable.
 */
const CLERK_WEBHOOK_EVENT_RETENTION_DAYS = 30;

export async function pruneClerkWebhookEvents(
  { limit = 1_000 }: { limit?: number } = {},
  db: Queryable = getPool(),
): Promise<number> {
  const boundedLimit = Math.max(1, Math.min(limit, 10_000));
  const result = await db.query(
    `with stale as (
       select ctid
         from clerk_webhook_events
        where received_at < now() - make_interval(days => $1)
        order by received_at, svix_id
        limit $2
     )
     delete from clerk_webhook_events
      where ctid in (select ctid from stale)`,
    [CLERK_WEBHOOK_EVENT_RETENTION_DAYS, boundedLimit],
  );
  return result.rowCount ?? 0;
}
