-- Fixed-window rate limiting for the ingest API (§11.10).
--
-- DB-backed on purpose: route handlers run on serverless/ephemeral processes
-- with no shared memory, and the stack has no Redis. One upsert per checked
-- request; `bucket` is "<scope>:<client-ip>". Rows are pruned by the same
-- housekeeping pass that reaps stale pending runs (§11.11), so the table stays
-- tiny — a day of traffic at most.

create table if not exists rate_limits (
  bucket       text        not null,
  window_start timestamptz not null,
  count        integer     not null default 0
               constraint rate_limits_count_positive_check check (count >= 0),
  primary key (bucket, window_start)
);

-- The prune pass deletes by age; keep it off a full-table scan as windows roll.
create index if not exists rate_limits_window_start_idx
  on rate_limits (window_start);
