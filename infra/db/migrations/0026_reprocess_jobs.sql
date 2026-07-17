-- Phase 6.7 §16e — bounded historical reprocessing and driver-finding
-- reconciliation. Raw frames remain in R2 Parquet; Postgres stores only queue
-- state and derived rollups.

create table reprocess_jobs (
  run_id      text not null references runs (id) on delete cascade,
  kind        text not null
              constraint reprocess_jobs_kind_check
              check (kind in ('full', 'driver')),
  -- The stable source generation that selected a driver job. Full Parquet jobs
  -- have no source generation; driver tombstones may revive only for a newer
  -- catalog/expiry generation.
  driver_source_watermark timestamptz,
  not_before  timestamptz not null default now(),
  attempts    integer not null default 0
              constraint reprocess_jobs_attempts_nonnegative_check
              check (attempts >= 0),
  locked_at   timestamptz,
  last_error  text,
  failed_at   timestamptz,
  created_at  timestamptz not null default now(),
  constraint reprocess_jobs_driver_source_watermark_check
    check ((kind = 'driver') = (driver_source_watermark is not null)),
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
    and status in ('validated', 'flagged');
create index diagnostics_rule_version_run_idx
  on diagnostics (code, rule_version nulls first, run_id);

-- The run-level watermark covers findings that do not currently exist, so a
-- catalog move can make a historical run gain as well as lose a finding.
alter table runs add column driver_evaluated_at timestamptz;
create index runs_driver_evaluated_at_idx
  on runs (driver_evaluated_at nulls first, id)
  where status in ('validated', 'flagged');

-- The driver sweep probes the latest source state and TTL crossings every
-- maintenance pass. These indexes keep both reads bounded as the per-game
-- requirements catalog grows.
create index driver_catalog_fetched_at_idx on driver_catalog (fetched_at);
create index game_driver_requirements_fetched_at_idx on game_driver_requirements (fetched_at);

-- Phase 6.6 named both source kinds as a catalog latest. Preserve stored
-- provenance while normalizing it to the Phase 6.7 source-neutral contract:
-- `referencedVersion` can be either a latest catalog row or a game minimum.
update diagnostics
   set evidence = jsonb_set(
         evidence,
         '{provenance}',
         ((evidence -> 'provenance') - 'latestVersion' - 'catalogFetchedAt')
         || case
              when (evidence -> 'provenance') ? 'latestVersion'
                then jsonb_build_object(
                  'referencedVersion', evidence -> 'provenance' -> 'latestVersion'
                )
              else '{}'::jsonb
            end
         || case
              when (evidence -> 'provenance') ? 'catalogFetchedAt'
                then jsonb_build_object(
                  'fetchedAt', evidence -> 'provenance' -> 'catalogFetchedAt'
                )
              else '{}'::jsonb
            end
       )
 where evidence ? 'provenance'
   and (
     (evidence -> 'provenance') ? 'latestVersion'
     or (evidence -> 'provenance') ? 'catalogFetchedAt'
   );

-- Display provenance only; never use a finding timestamp as the sweep key.
alter table diagnostics add column evaluated_at timestamptz;

-- One tiny guard row per reprocess lane. `updated_at` also records the last
-- completed sweep, which lets the driver lane detect catalog TTL crossings.
create table reprocess_watermarks (
  key        text primary key,
  value      timestamptz not null,
  updated_at timestamptz not null default now()
);
