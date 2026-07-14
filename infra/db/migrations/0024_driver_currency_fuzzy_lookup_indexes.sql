-- Phase 6.6 scale follow-up: fuzzy game-title resolution is bounded at the
-- source, but it must not cross join each incoming title with every game and
-- alias as the dictionaries grow. These expression indexes support the
-- token-overlap prefilter in the curation query; the query still computes the
-- exact conservative score before persisting a requirement.

create index if not exists games_normalized_name_tokens_gin_idx
  on games using gin ((regexp_split_to_array(lower(name), '\s+')));

create index if not exists game_aliases_normalized_name_tokens_gin_idx
  on game_aliases using gin ((regexp_split_to_array(normalized_name, '\s+')));
