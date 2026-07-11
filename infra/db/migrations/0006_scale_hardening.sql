-- Scale hardening before ingest volume exists.
--
-- Keep terminal verification jobs out of the worker-claim index, make owner-run
-- listings keyset-friendly, and align persisted summary metrics with the Phase
-- 3 parser contract: summaries always come from at least one positive frame.

drop index if exists verification_jobs_status_locked_at_idx;
create index verification_jobs_status_locked_at_idx
  on verification_jobs (status, locked_at, created_at, id)
  where status in ('pending', 'running');

drop index if exists runs_user_id_idx;
create index runs_user_id_idx
  on runs (user_id, created_at desc, id desc)
  where user_id is not null;

alter table run_summaries
  drop constraint if exists run_summaries_nonnegative_metrics_check,
  add constraint run_summaries_nonnegative_metrics_check
  check (
    avg_fps > 0
    and p1_low_fps > 0
    and p01_low_fps > 0
    and (min_fps is null or min_fps > 0)
    and (max_fps is null or max_fps > 0)
    and frametime_p50_ms > 0
    and frametime_p95_ms > 0
    and frametime_p99_ms > 0
    and stutter_count >= 0
    and sample_count > 0
    and duration_seconds > 0
    and (gpu_avg_power is null or gpu_avg_power >= 0)
    and (gpu_avg_clock_mhz is null or gpu_avg_clock_mhz >= 0)
  );
