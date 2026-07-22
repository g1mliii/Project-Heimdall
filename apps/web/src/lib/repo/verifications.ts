/**
 * Verified-reviewer tier (§20.3) — the trust anchor for public averages.
 * `verifications` is the authoritative grant/audit record; `users.role` is
 * the query-time source of truth every surface actually reads (never join
 * `verifications` at read time — see `lib/repo/distribution.ts`). The two
 * are written atomically here so they can never drift apart.
 *
 * Role is a single three-state enum (`public`/`verified`/`admin`), not a set
 * of independent flags, so grant/revoke are no-ops against an admin: an
 * admin's trust already supersedes "verified", and revoking someone's
 * verified status must never accidentally demote an admin to `public`.
 */

import { getPool, query, type Queryable } from "../db";
import type { UserRecord } from "./users";

export interface VerificationRecord {
  userId: string;
  verifiedBy: string | null;
  hardwareVetted: boolean;
  grantedAt: string;
}

/** `POST /api/admin/verifications` — grant, idempotent (re-granting refreshes the audit record). */
export async function grantVerification(
  userId: string,
  grantedBy: string,
  hardwareVetted: boolean,
  db: Queryable = getPool(),
): Promise<UserRecord | null> {
  const rows = await query<{ id: string; handle: string | null; email: string | null; role: string }>(
    `with target as (
       update users
          set role = case when role = 'public' then 'verified' else role end
        where id = $1
        returning id, handle, email, role
     ), audit as (
       insert into verifications (user_id, verified_by, hardware_vetted)
       select id, $2, $3 from target
       on conflict (user_id) do update
         set verified_by = excluded.verified_by,
             hardware_vetted = excluded.hardware_vetted,
             granted_at = now()
     )
     select id, handle, email, role from target`,
    [userId, grantedBy, hardwareVetted],
    db,
  );
  const row = rows[0];
  return row ? { id: row.id, handle: row.handle, email: row.email, role: row.role as UserRecord["role"] } : null;
}

/** `DELETE /api/admin/verifications` — revoke; the audit record is deleted, not tombstoned. */
export async function revokeVerification(
  userId: string,
  db: Queryable = getPool(),
): Promise<UserRecord | null> {
  const rows = await query<{ id: string; handle: string | null; email: string | null; role: string }>(
    `with target as (
       update users
          set role = case when role = 'verified' then 'public' else role end
        where id = $1
        returning id, handle, email, role
     ), audit as (
       delete from verifications
        where user_id = $1
          and exists (select 1 from target)
     )
     select id, handle, email, role from target`,
    [userId],
    db,
  );
  const row = rows[0];
  return row ? { id: row.id, handle: row.handle, email: row.email, role: row.role as UserRecord["role"] } : null;
}
