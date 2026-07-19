-- Comparisons, verified-reviewer tier, and the durable verification queue
-- (PLAN.md §4; IMPLEMENTATION_PLAN §4.1).

-- Before/after validator (Phase 10).
create table if not exists comparisons (
  id            bigint generated always as identity primary key,
  user_id       text references users (id) on delete cascade,
  before_run_id text not null references runs (id) on delete cascade,
  after_run_id  text not null references runs (id) on delete cascade,
  summary_text  text,
  created_at    timestamptz not null default now()
);

-- Verified-reviewer tier (Phase 8 §20.3) — the trust anchor for public averages.
create table if not exists verifications (
  user_id         text primary key references users (id) on delete cascade,
  verified_by     text references users (id),
  hardware_vetted boolean not null default false,
  granted_at      timestamptz not null default now()
);

-- Durable server-side canonical-recompute queue (§11.5). DB-backed — no
-- fire-and-forget serverless promise. Workers claim rows via status + locked_at;
-- Phase 7 extends the worker with cohort-facing diagnostics while recomputation
-- remains the reproducible integrity decision.
-- Status values mirror VerificationJobStatus in packages/shared/src/types.ts.
create table if not exists verification_jobs (
  id         bigint generated always as identity primary key,
  run_id     text not null references runs (id) on delete cascade,
  status     text not null default 'pending'
             constraint verification_jobs_status_check
             check (status in ('pending', 'running', 'succeeded', 'failed')),
  attempts   integer not null default 0,
  locked_at  timestamptz,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Keep updated_at honest mechanically — worker claim/retry/finish UPDATEs
-- must not be trusted to remember it (stuck-job reaping reads this column).
create or replace function set_updated_at() returns trigger
language plpgsql as $$
begin
  new.updated_at := clock_timestamp();
  return new;
end;
$$;

drop trigger if exists verification_jobs_set_updated_at on verification_jobs;
create trigger verification_jobs_set_updated_at
  before update on verification_jobs
  for each row execute function set_updated_at();
