-- The public aggregate index starts with game_id, but excludes private,
-- pending, flagged, and unresolved runs. Index every non-null child key so
-- future game merges/rekeys and foreign-key checks never scan the full runs
-- table as ingest volume grows.

create index if not exists runs_game_id_idx
  on runs (game_id)
  where game_id is not null;
