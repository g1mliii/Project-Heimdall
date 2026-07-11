-- Runs, precomputed summaries, diagnostics (PLAN.md §4; IMPLEMENTATION_PLAN §4.1).
--
-- INVARIANT (§4.3): per-frame data is Parquet in R2 — there is deliberately NO
-- frames/per-frame table here, and there never will be. `frames_object_key`
-- points at the R2 object (a key, not a URL, superseding PLAN §4's raw_blob_url:
-- the bucket/base URL can change; the key cannot).
--
-- CHECK constraint values mirror packages/shared/src/visibility.ts
-- (RUN_VISIBILITY, RUN_STATUS) and types.ts (CaptureSource, GeneratedFrameTech,
-- GpuVendor, ConfidenceLevel, DiagnosticSeverity). Keep in lockstep — the shared
-- constants are the source of truth.

create table if not exists runs (
  id              text primary key, -- app-generated unguessable id: `unlisted` is link-scoped (§1.1)
  user_id         text references users (id) on delete cascade, -- NULLABLE: anonymous allowed (§1.2)
  game_raw        text not null,    -- raw title as submitted
  game_id         bigint references games (id), -- canonical id once resolved (§11.9)
  gpu_hardware_id bigint references hardware (id),
  cpu_hardware_id bigint references hardware (id),

  capture_source  text not null
                  constraint runs_capture_source_check
                  check (capture_source in ('presentmon', 'mangohud', 'capframex')),
  visibility      text not null default 'unlisted'
                  constraint runs_visibility_check
                  check (visibility in ('private', 'unlisted', 'public')),
  status          text not null default 'pending'
                  constraint runs_status_check
                  check (status in ('pending', 'validated', 'flagged', 'hidden')),

  -- Tamper-evidence, not gatekeeping (§11.7).
  signature                       text,
  signature_valid                 boolean,
  -- Hash only — the raw anonymous management/delete token is never stored (§1.2).
  anonymous_management_token_hash text,

  -- Raw hardware/software snapshot (quasi-identifying; see docs/integrity-and-privacy.md §5).
  cpu_model      text not null,
  gpu_model      text not null,
  gpu_vendor     text
                 constraint runs_gpu_vendor_check
                 check (gpu_vendor in ('nvidia', 'amd', 'intel', 'unknown')),
  gpu_driver     text,
  ram_gb         double precision,
  -- Unit is MT/s (matches shared ramRatedSpeedMtps/ramSpeedMtps; PLAN §4 wrote
  -- "_mhz" but DDR transfer rates are megatransfers, ~2x the clock MHz).
  ram_rated_mtps  integer, -- rated (SPD/XMP); best-effort, drives §15.3
  ram_actual_mtps integer,
  motherboard    text,
  os_build       text,

  -- Run context.
  graphics_api        text, -- 'dx12' | 'vulkan' | … (open set; no CHECK)
  resolution          text,
  settings_json       jsonb,
  generated_frame_tech text not null default 'none'
                      constraint runs_generated_frame_tech_check
                      check (generated_frame_tech in ('none', 'dlss3', 'fsr3', 'xess')),

  frames_object_key text, -- R2 key (`runs/{id}.parquet`); null until upload finalizes

  -- Ingest provenance so old uploads reprocess safely (§2.2).
  schema_version integer not null,
  parser_version text not null,

  created_at timestamptz not null default now()
);

-- Precomputed so pages never aggregate on load (PLAN §4). Canonical once the
-- §11.5 server recompute validates it. Secondary-sensor aggregates are nullable:
-- not every source/vendor reports them (§7.3).
create table if not exists run_summaries (
  run_id  text primary key references runs (id) on delete cascade,

  avg_fps     double precision not null,
  p1_low_fps  double precision not null,
  p01_low_fps double precision not null,
  min_fps     double precision,
  max_fps     double precision,

  frametime_p50_ms double precision not null,
  frametime_p95_ms double precision not null,
  frametime_p99_ms double precision not null,

  stutter_count       integer not null,
  generated_frame_pct double precision not null
                      constraint run_summaries_generated_frame_pct_check
                      check (generated_frame_pct >= 0 and generated_frame_pct <= 1),
  -- 0.1%-low confidence by sample count (§9.2).
  p01_low_confidence  text not null
                      constraint run_summaries_p01_low_confidence_check
                      check (p01_low_confidence in ('high', 'medium', 'low')),
  sample_count        integer not null,
  duration_seconds    double precision not null,

  gpu_avg_load      double precision,
  gpu_avg_power     double precision,
  gpu_avg_clock_mhz double precision,
  vram_peak_pct     double precision,
  cpu_avg_load      double precision
);

-- Rules-engine output (Phase 6).
create table if not exists diagnostics (
  id         bigint generated always as identity primary key,
  run_id     text not null references runs (id) on delete cascade,
  code       text not null, -- stable rule id, e.g. 'vram-saturation-stutter'
  severity   text not null
             constraint diagnostics_severity_check
             check (severity in ('good', 'warn', 'bad', 'info')),
  message    text not null,
  created_at timestamptz not null default now()
);
