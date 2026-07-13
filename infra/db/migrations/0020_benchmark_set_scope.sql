-- Phase 6.5 §16c.2 follow-up — benchmark-set membership must be scoped by an
-- opaque, browser-held capability rather than a human label. A public label
-- alone would let unrelated anonymous uploads accidentally (or deliberately)
-- join the same repeatability group.
--
-- The runs table retains the id so historical/raw rows remain simple. New
-- writes atomically register or verify the set in `insertRun`; only the SHA-256
-- hash of the joining secret is stored. The display label is intentionally
-- local to the browser and never enters Postgres.

create table if not exists benchmark_sets (
  id          text primary key,
  secret_hash text not null,
  created_at  timestamptz not null default now()
);

-- Preserve historical label-based rows as read-only legacy sets. The new API
-- accepts UUID ids only, so no new client can join one; the placeholder hash
-- satisfies the table contract without pretending an unrecoverable old label
-- had a secret.
insert into benchmark_sets (id, secret_hash)
select distinct benchmark_set_id, 'legacy:' || md5(benchmark_set_id)
  from runs
 where benchmark_set_id is not null
on conflict (id) do nothing;

do $$
begin
  if not exists (
    select 1
      from pg_constraint
     where conname = 'runs_benchmark_set_id_fkey'
       and conrelid = 'runs'::regclass
  ) then
    alter table runs
      add constraint runs_benchmark_set_id_fkey
      foreign key (benchmark_set_id) references benchmark_sets (id);
  end if;
end $$;

-- The repeatability read starts with a set id and compares only public,
-- validated runs that have a full declared methodology profile. This narrow
-- partial index avoids scanning a large user's historical set in memory.
create index if not exists runs_public_benchmark_set_profile_idx
  on runs (
    benchmark_set_id,
    game_id,
    gpu_hardware_id,
    resolution,
    upscaler,
    ray_tracing,
    generated_frame_tech,
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
