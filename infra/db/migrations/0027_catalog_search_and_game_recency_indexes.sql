-- Phase 7.0 catalog search + game submissions hot paths.
--
-- pg_trgm is database-scoped while tests migrate isolated schemas in parallel,
-- so keep the extension and its operator classes in public. Each suite places
-- its own schema before public on search_path; tables and indexes therefore stay
-- isolated while every suite shares the same immutable operator class.

create extension if not exists pg_trgm with schema public;

create index if not exists games_name_trgm_idx
  on games using gin (name public.gin_trgm_ops);

create index if not exists games_slug_trgm_idx
  on games using gin (slug public.gin_trgm_ops);

create index if not exists game_aliases_normalized_name_trgm_idx
  on game_aliases using gin (normalized_name public.gin_trgm_ops);

create index if not exists hardware_canonical_name_trgm_idx
  on hardware using gin (canonical_name public.gin_trgm_ops);

create index if not exists hardware_aliases_normalized_name_trgm_idx
  on hardware_aliases using gin (normalized_name public.gin_trgm_ops);

-- The wide comparability index cannot provide recency ordering when only the
-- game is known: created_at and id sit behind every cohort dimension. This
-- partial index makes each public submissions page an ordered, bounded scan.
create index if not exists runs_game_recent_idx
  on runs (game_id, created_at desc, id desc)
  where status = 'validated'
    and visibility = 'public'
    and game_id is not null;
