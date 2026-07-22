-- Phase 8 schema, account-erasure fencing, and new-write integrity.
--
-- Existing rows are verified by 0038 after these constraints start enforcing
-- new writes. This avoids a table scan while holding the stronger DDL lock
-- required to install the constraint. The migration runner supplies bounded
-- lock and statement timeouts for the short DDL sections.

-- An admin must be erasable after granting another user a verification. Keep
-- the grant's audit record, but remove the erased admin reference.
alter table verifications
  drop constraint if exists verifications_verified_by_fkey,
  add constraint verifications_verified_by_fkey
  foreign key (verified_by) references users (id) on delete set null not valid;

-- Durable, bounded account erasure (Phase 8.5). Clerk's verified user.deleted
-- webhook tombstones owned runs and inserts this job atomically; maintenance
-- deletes storage in small retryable batches before deleting the user row.
create table if not exists account_erasure_jobs (
  user_id         text primary key references users (id) on delete cascade,
  not_before      timestamptz not null default now(),
  locked_at       timestamptz,
  attempts        integer not null default 0 check (attempts >= 0),
  last_attempt_at timestamptz,
  last_error      text,
  created_at      timestamptz not null default now()
);

create index if not exists account_erasure_jobs_due_idx
  on account_erasure_jobs (not_before, user_id);

-- Account-erasure fencing and replay-safe Clerk delivery (Phase 8 §20.1b,
-- §20.4). The tombstone stores only a domain-separated SHA-256 of the Clerk
-- id: it is the minimum durable state needed to prevent a stale session or
-- out-of-order user.updated webhook from recreating an erased profile.
alter table users
  add column if not exists erasure_requested_at timestamptz;

create table if not exists account_erasure_tombstones (
  user_id_hash  text primary key
                constraint account_erasure_tombstones_hash_check
                check (user_id_hash ~ '^[0-9a-f]{64}$'),
  deleted_at    timestamptz not null default now()
);

create table if not exists clerk_webhook_events (
  svix_id       text primary key,
  user_id_hash  text not null
                constraint clerk_webhook_events_user_hash_check
                check (user_id_hash ~ '^[0-9a-f]{64}$'),
  event_type    text not null
                constraint clerk_webhook_events_type_check
                check (event_type in ('user.created', 'user.updated', 'user.deleted')),
  received_at   timestamptz not null default now()
);

-- Dedupe state has a retention reaper; it is not an indefinite audit log.
create index if not exists clerk_webhook_events_received_at_idx
  on clerk_webhook_events (received_at, svix_id);

-- A route may have read a valid Clerk session immediately before deletion was
-- requested. Enforce the fence in Postgres too, so a direct repository caller
-- cannot attach a new run while the R2 deletion worker is draining.
create or replace function reject_erasing_run_owner()
returns trigger
language plpgsql
as $$
begin
  if new.user_id is not null and exists (
    select 1
      from users
     where id = new.user_id
       and erasure_requested_at is not null
  ) then
    raise exception using
      errcode = '23514',
      message = 'cannot attach a run to an account being erased';
  end if;
  return new;
end;
$$;

drop trigger if exists runs_reject_erasing_owner on runs;
create trigger runs_reject_erasing_owner
before insert or update of user_id on runs
for each row execute function reject_erasing_run_owner();

-- These large-table checks start enforcing every new write now. 0038 validates
-- historical rows with PostgreSQL's online-friendly VALIDATE operation.
alter table reports
  add constraint reports_subject_matches_type_check
  check (
    (subject_type = 'run' and subject_run_id is not null and subject_game_id is null)
    or
    (subject_type = 'game' and subject_game_id is not null and subject_run_id is null)
  ) not valid;

alter table runs
  add constraint runs_private_owner_check
  check (visibility <> 'private' or user_id is not null) not valid;

-- A durable cohort assessment must remember the game it was calculated for.
-- Leave legacy rows nullable; the bounded scanner converges them without a
-- deploy-time table-wide backfill.
alter table run_cohort_assessments
  add column if not exists game_id bigint references games (id);

update cohort_assessment_scan_state
   set assessment_version = 0,
       last_game_id = 0,
       updated_at = now()
 where singleton = true;
