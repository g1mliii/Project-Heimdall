-- Phase 6.5 follow-up — 0018 omitted three frame-pacing components of the
-- comparability key. Keep this forward-only so a database that already applied
-- 0018 receives the same complete Phase 7 index as a fresh installation.
--
-- The migration runner executes each file in a transaction, so Postgres's
-- CREATE INDEX CONCURRENTLY is unavailable here. The existing 0018 migration
-- already rebuilds this not-yet-public index transactionally; retain that
-- operational contract rather than adding an unsafe special-case runner.

drop index if exists runs_game_gpu_idx;

create index if not exists runs_game_gpu_idx
  on runs (
    game_id,
    gpu_hardware_id,
    resolution,
    upscaler,
    ray_tracing,
    generated_frame_tech,
    frame_pacing_cap,
    vsync,
    vrr,
    scene_type,
    created_at desc,
    id desc
  )
  where status = 'validated'
    and visibility = 'public'
    and game_id is not null
    and gpu_hardware_id is not null;
