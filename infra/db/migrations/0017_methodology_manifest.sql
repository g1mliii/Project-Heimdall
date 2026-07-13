-- Phase 6.5 §16c — reproducible methodology manifest, comparability columns,
-- and benchmark-set membership on `runs`. Forward-only from 0016, additive +
-- idempotent by convention (all `add column`, relying on the schema_migrations
-- skip on re-run).
--
-- INVARIANT: the methodology manifest is QUASI-IDENTIFYING (docs/integrity-and-
-- privacy.md §5) and inherits the hardware-snapshot privacy/deletion rules — it
-- lives on `runs`, so it cascades on run delete via the existing FKs.
--
-- The descriptive blob reuses the already-present but never-written
-- `runs.settings_json`; only the QUERYABLE comparability-key fields get
-- dedicated columns so Phase 7 can index + GROUP BY them. `resolution`,
-- `graphics_api`, and `generated_frame_tech` already exist and are reused.

-- The full declared methodology manifest (source of truth), + its version.
alter table runs add column methodology_manifest_version integer;
-- (settings_json already exists from 0002 — populated by insertRun, not re-added.)

-- Queryable comparability-key columns (§16c.3). Nullable: a run without a
-- declared methodology simply has no comparability profile and is excluded from
-- pooled aggregates by the Phase 7 eligibility guard, not by these columns.
alter table runs add column upscaler text
  constraint runs_upscaler_check
  check (upscaler is null or upscaler in ('none', 'dlss', 'fsr', 'xess', 'unknown'));
alter table runs add column ray_tracing text
  constraint runs_ray_tracing_check
  check (ray_tracing is null or ray_tracing in ('off', 'on', 'unknown'));
alter table runs add column frame_pacing_cap integer
  constraint runs_frame_pacing_cap_positive_check
  check (frame_pacing_cap is null or frame_pacing_cap > 0);
alter table runs add column vsync boolean;
alter table runs add column vrr boolean;

-- Scene tag (§17.5): a benchmark-scene never pools with gameplay; freeform stays
-- separately filterable.
alter table runs add column scene_type text
  constraint runs_scene_type_check
  check (scene_type is null or scene_type in ('benchmark-scene', 'gameplay', 'freeform'));

-- Benchmark-set membership (§16c.2). Every raw run is retained; warm-ups are
-- marked (never deleted, never promoted) and excluded from set statistics.
alter table runs add column benchmark_set_id text;
alter table runs add column is_warmup boolean not null default false;

-- Group a benchmark set's runs without scanning; partial so it stays small.
create index if not exists runs_benchmark_set_id_idx
  on runs (benchmark_set_id, created_at)
  where benchmark_set_id is not null;
