-- Make retryable verification failures durable and ineligible until their
-- backoff expires. Existing jobs remain immediately eligible after upgrade.
alter table verification_jobs
  add column if not exists not_before timestamptz not null default now();

drop index if exists verification_jobs_status_locked_at_idx;
create index verification_jobs_status_locked_at_idx
  on verification_jobs (status, not_before, locked_at, created_at, id)
  where status in ('pending', 'running');
