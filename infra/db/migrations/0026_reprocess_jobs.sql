-- Phase 6.7 §16e — bounded historical reprocessing and driver-finding
-- reconciliation. Raw frames remain in R2 Parquet; Postgres stores only queue
-- state and derived rollups.

create table reprocess_jobs (
  run_id      text not null references runs (id) on delete cascade,
  kind        text not null
              constraint reprocess_jobs_kind_check
              check (kind in ('full', 'driver')),
  not_before  timestamptz not null default now(),
  attempts    integer not null default 0
              constraint reprocess_jobs_attempts_nonnegative_check
              check (attempts >= 0),
  locked_at   timestamptz,
  last_error  text,
  failed_at   timestamptz,
  created_at  timestamptz not null default now(),
  primary key (run_id, kind)
);

-- Successful rows are deleted; terminal failures remain as tombstones so an
-- enumeration pass cannot retry an irrecoverable historical object forever.
create index reprocess_jobs_claim_idx
  on reprocess_jobs (kind, not_before, created_at, run_id)
  where failed_at is null;

-- Full enumeration has two independent, self-clearing sources: old capability
-- contracts and stored findings from an older rule version. Each gets a narrow
-- access path so the operator CLI never scans all historical runs.
create index runs_reprocess_capability_idx
  on runs (capability_manifest_version nulls first, created_at, id)
  where frames_object_key is not null
    and status <> 'hidden';
create index diagnostics_rule_version_run_idx
  on diagnostics (code, rule_version, run_id);

-- The run-level watermark covers findings that do not currently exist, so a
-- catalog move can make a historical run gain as well as lose a finding.
alter table runs add column driver_evaluated_at timestamptz;
create index runs_driver_evaluated_at_idx
  on runs (driver_evaluated_at nulls first, id)
  where status <> 'hidden';

-- Display provenance only; never use a finding timestamp as the sweep key.
alter table diagnostics add column evaluated_at timestamptz;

-- One tiny guard row per reprocess lane. `updated_at` also records the last
-- completed sweep, which lets the driver lane detect catalog TTL crossings.
create table reprocess_watermarks (
  key        text primary key,
  value      timestamptz not null,
  updated_at timestamptz not null default now()
);
