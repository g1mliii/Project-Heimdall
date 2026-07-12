-- Keep maintenance claims index-ordered before the queue has production volume.
-- `not_before` is both retry eligibility and the active worker's lease
-- deadline. A fresh running claim is therefore naturally ineligible until its
-- bounded lease expires; no OR predicate or lock-time sort is needed.

-- Compatibility guard for a rolling deploy: pre-0011 workers only wrote
-- `locked_at`. Installing these triggers before the backfill means an old
-- worker that claims just after this migration commits still receives at
-- least the default 10-minute `not_before` lease, so a new worker cannot
-- double-claim it. New workers retain any longer requested lease.
create or replace function set_verification_job_lease_deadline() returns trigger
language plpgsql as $$
begin
  if new.status = 'running'
     and new.locked_at is not null
     and new.locked_at is distinct from old.locked_at then
    new.not_before := greatest(new.not_before, new.locked_at + interval '10 minutes');
  end if;
  return new;
end;
$$;

drop trigger if exists verification_jobs_set_lease_deadline on verification_jobs;
create trigger verification_jobs_set_lease_deadline
  before update on verification_jobs
  for each row execute function set_verification_job_lease_deadline();

create or replace function set_staging_cleanup_job_lease_deadline() returns trigger
language plpgsql as $$
begin
  if new.locked_at is not null
     and new.locked_at is distinct from old.locked_at then
    new.not_before := greatest(new.not_before, new.locked_at + interval '10 minutes');
  end if;
  return new;
end;
$$;

drop trigger if exists staging_cleanup_jobs_set_lease_deadline on staging_cleanup_jobs;
create trigger staging_cleanup_jobs_set_lease_deadline
  before update on staging_cleanup_jobs
  for each row execute function set_staging_cleanup_job_lease_deadline();

update verification_jobs
   set not_before = greatest(not_before, coalesce(locked_at + interval '10 minutes', now()))
 where status = 'running';

update staging_cleanup_jobs
   set not_before = greatest(not_before, coalesce(locked_at + interval '10 minutes', now()))
 where locked_at is not null;

drop index if exists verification_jobs_status_locked_at_idx;
create index verification_jobs_active_claim_idx
  on verification_jobs (not_before, created_at, id)
  where status in ('pending', 'running');

-- The TTL reaper reads a bounded oldest-first batch of pending uploads that
-- never finalized. Keep finalized and terminal rows out of its index so ingest
-- volume cannot turn housekeeping into a sort or table scan.
create index runs_pending_unfinalized_created_at_idx
  on runs (created_at, id)
  where status = 'pending'
    and frames_object_key is null;
