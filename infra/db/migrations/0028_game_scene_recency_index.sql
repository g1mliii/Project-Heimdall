-- Phase 7.0 submissions-table scene filters must seek directly to their
-- workload, not scan a popular game's complete recency feed looking for a
-- sparse scene. Keep the index public + validated like the unfiltered table
-- path, and omit legacy rows because a requested scene type is never NULL.

create index if not exists runs_game_scene_recent_idx
  on runs (game_id, scene_type, created_at desc, id desc)
  where status = 'validated'
    and visibility = 'public'
    and game_id is not null
    and scene_type is not null;
