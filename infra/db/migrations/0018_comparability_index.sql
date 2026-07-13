-- Phase 6.5 §16c.3 — extend the game×GPU distribution index (0004's
-- runs_game_gpu_idx) with the comparability-key columns, so Phase 7 can bucket
-- aggregate pages by comparable methodology without a full scan. Forward-only
-- from 0017; idempotent within this file (drop-if-exists → create-if-not-exists).
--
-- Postgres can't ALTER an index's key list, so the extension is a drop + rebuild
-- of the SAME name. The partial predicate is unchanged — only public+validated,
-- game/GPU-resolved rows are aggregate-eligible (§4.5), so ingest churn never
-- bloats this path.

drop index if exists runs_game_gpu_idx;

create index if not exists runs_game_gpu_idx
  on runs (
    game_id,
    gpu_hardware_id,
    resolution,
    upscaler,
    ray_tracing,
    generated_frame_tech,
    scene_type,
    created_at desc,
    id desc
  )
  where status = 'validated'
    and visibility = 'public'
    and game_id is not null
    and gpu_hardware_id is not null;
