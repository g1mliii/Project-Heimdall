-- Phase 7.5 §18.5 — drive the cohort-assessment queue from cohort-changing
-- mutations. The initial/version-change scan is resumable by game id; normal
-- maintenance must not expand every eligible benchmark-set member just to find
-- a newly verified run.

create table cohort_assessment_scan_state (
  singleton          boolean primary key default true check (singleton),
  -- Zero is the uninitialized sentinel. The worker writes a positive shared
  -- assessment version before scanning, which also makes a migration/version
  -- bump atomically rewind the cursor.
  assessment_version integer not null check (assessment_version >= 0),
  last_game_id       bigint not null default 0,
  updated_at         timestamptz not null default now()
);

create or replace function enqueue_cohort_assessment_game(target_game_id bigint)
returns void
language plpgsql
as $$
begin
  if target_game_id is null then
    return;
  end if;

  insert into cohort_assessment_jobs (game_id)
  values (target_game_id)
  on conflict (game_id) do nothing;
end;
$$;

create or replace function enqueue_cohort_assessment_for_run()
returns trigger
language plpgsql
as $$
begin
  if tg_op <> 'insert' then
    perform enqueue_cohort_assessment_game(old.game_id);
  end if;
  if tg_op <> 'delete' then
    perform enqueue_cohort_assessment_game(new.game_id);
  end if;
  return null;
end;
$$;

create trigger runs_cohort_assessment_enqueue_insert_delete
after insert or delete on runs
for each row execute function enqueue_cohort_assessment_for_run();

create trigger runs_cohort_assessment_enqueue_update
after update of game_id, visibility, status, gpu_hardware_id,
  capability_manifest_version, methodology_manifest_version, is_warmup,
  benchmark_set_id, resolution, scene_type, settings_preset, upscaler,
  ray_tracing, graphics_api, generated_frame_tech on runs
for each row execute function enqueue_cohort_assessment_for_run();

create or replace function enqueue_cohort_assessment_for_summary()
returns trigger
language plpgsql
as $$
declare
  target_run_id text;
begin
  target_run_id := case when tg_op = 'delete' then old.run_id else new.run_id end;
  perform enqueue_cohort_assessment_game((select game_id from runs where id = target_run_id));
  return null;
end;
$$;

create trigger run_summaries_cohort_assessment_enqueue
after insert or update or delete on run_summaries
for each row execute function enqueue_cohort_assessment_for_summary();
