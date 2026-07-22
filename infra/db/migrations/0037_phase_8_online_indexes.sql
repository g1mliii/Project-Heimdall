-- migrate:nontransactional
-- Supporting indexes for Phase 8 foreign-key actions and cohort cleanup. They
-- run outside the runner transaction so production reads and writes continue
-- during index construction; migrate.mjs applies bounded DDL timeouts.
--
-- Do not use CREATE INDEX CONCURRENTLY IF NOT EXISTS here. If an interrupted
-- concurrent build leaves an invalid index, that form silently retains it on a
-- retry. Rebuilding an existing index is safe because this migration is only
-- retried before its schema_migrations record is committed, and all operations
-- below remain online.

-- migrate:statement
drop index concurrently if exists reports_reporter_user_id_idx;

-- migrate:statement
create index concurrently reports_reporter_user_id_idx
  on reports (reporter_user_id)
  where reporter_user_id is not null;

-- migrate:statement
drop index concurrently if exists reports_resolved_by_idx;

-- migrate:statement
create index concurrently reports_resolved_by_idx
  on reports (resolved_by)
  where resolved_by is not null;

-- migrate:statement
drop index concurrently if exists run_cohort_assessments_game_id_idx;

-- migrate:statement
create index concurrently run_cohort_assessments_game_id_idx
  on run_cohort_assessments (game_id, run_id)
  where game_id is not null;
