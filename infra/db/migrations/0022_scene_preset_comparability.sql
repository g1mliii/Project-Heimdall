-- Phase 6.5 follow-up — a declared route and graphics preset are methodology
-- semantics, not display-only notes. Mirror them into queryable columns so
-- public aggregates and benchmark-set repeatability never mix different runs.

alter table runs add column scene text;
alter table runs add column settings_preset text;

-- Older manifests accepted 512-character descriptive values. Keep legacy
-- outliers distinct without exceeding the comparability B-tree tuple limit.
update runs
   set scene = case
         when scene is null and settings_json ? 'scene' then
           case
             when char_length(settings_json ->> 'scene') <= 64 then settings_json ->> 'scene'
             else 'legacy:' || md5(settings_json ->> 'scene')
           end
         else scene
       end,
       settings_preset = case
         when settings_preset is null and settings_json ? 'settingsPreset' then
           case
             when char_length(settings_json ->> 'settingsPreset') <= 64 then settings_json ->> 'settingsPreset'
             else 'legacy:' || md5(settings_json ->> 'settingsPreset')
           end
         else settings_preset
       end
 where (scene is null and settings_json ? 'scene')
    or (settings_preset is null and settings_json ? 'settingsPreset');

drop index if exists runs_game_gpu_idx;

create index if not exists runs_game_gpu_idx
  on runs (
    game_id,
    gpu_hardware_id,
    resolution,
    scene,
    settings_preset,
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
    scene,
    settings_preset,
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
    and scene is not null
    and settings_preset is not null
    and upscaler is not null
    and ray_tracing is not null
    and vsync is not null
    and vrr is not null
    and scene_type is not null;
