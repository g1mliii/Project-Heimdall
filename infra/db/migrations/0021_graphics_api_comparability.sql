-- Phase 6.5 follow-up — graphics API is a rendering-pipeline semantic. Both
-- Phase 7 distributions and the §16c.2 repeatability read compare it, so the
-- supporting partial indexes must carry it too. This remains forward-only for
-- databases that already applied 0019/0020.

-- `settings_json` has held the versioned methodology manifest since 0017.
-- Populate the query column for rows written before `insertRun` mirrored this
-- field so existing DX11/DX12/Vulkan runs do not collapse into the null bucket.
-- Older manifests accepted a longer descriptive API string than the new index
-- contract. Hash only those legacy outliers so they stay distinct without
-- risking an oversized B-tree tuple.
update runs
   set graphics_api = case
     when char_length(settings_json ->> 'graphicsApi') <= 64
       then settings_json ->> 'graphicsApi'
     else 'legacy:' || md5(settings_json ->> 'graphicsApi')
   end
 where graphics_api is null
   and settings_json ? 'graphicsApi';

drop index if exists runs_game_gpu_idx;

create index if not exists runs_game_gpu_idx
  on runs (
    game_id,
    gpu_hardware_id,
    resolution,
    upscaler,
    ray_tracing,
    generated_frame_tech,
    graphics_api,
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

drop index if exists runs_public_benchmark_set_profile_idx;

create index if not exists runs_public_benchmark_set_profile_idx
  on runs (
    benchmark_set_id,
    game_id,
    gpu_hardware_id,
    resolution,
    upscaler,
    ray_tracing,
    generated_frame_tech,
    graphics_api,
    frame_pacing_cap,
    vsync,
    vrr,
    scene_type
  )
  where benchmark_set_id is not null
    and status = 'validated'
    and visibility = 'public'
    and methodology_manifest_version is not null
    and resolution is not null
    and upscaler is not null
    and ray_tracing is not null
    and vsync is not null
    and vrr is not null
    and scene_type is not null;
