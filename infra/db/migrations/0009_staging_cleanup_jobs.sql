-- A finalized upload's browser PUT URL remains valid briefly. Keep a durable
-- cleanup record until that window has elapsed so a late staging write cannot
-- become an orphan. This deliberately has NO foreign key: anonymous run
-- deletion must not discard the cleanup work while the old PUT URL is valid.

create table staging_cleanup_jobs (
  run_id          text primary key,
  object_key      text not null unique,
  not_before      timestamptz not null,
  attempts        integer not null default 0
                  constraint staging_cleanup_jobs_attempts_nonnegative_check check (attempts >= 0),
  locked_at       timestamptz,
  last_attempt_at timestamptz,
  last_error      text,
  created_at      timestamptz not null default now()
);

create index staging_cleanup_jobs_not_before_idx
  on staging_cleanup_jobs (not_before, run_id);

-- Existing finalized rows need a queue only while their original PUT URL could
-- still be valid. Older staging objects remain covered by the bucket lifecycle
-- rule, avoiding an unbounded migration-time sweep.
insert into staging_cleanup_jobs (run_id, object_key, not_before)
select id,
       'staging/runs/' || id || '.parquet',
       greatest(created_at + interval '15 minutes', now())
  from runs
 where frames_object_key is not null
   and created_at > now() - interval '15 minutes'
on conflict (run_id) do nothing;
