-- Numeric integrity constraints (Phase 2 hardening).
--
-- Shared Zod schemas reject negative summary/hardware values before insert, but
-- Postgres is the source of truth once ingest exists. Keep the database aligned
-- with those runtime contracts so a missed validation path cannot persist
-- physically impossible metrics.

alter table runs
  add constraint runs_positive_hardware_metrics_check
  check (
    (ram_gb is null or ram_gb > 0)
    and (ram_rated_mtps is null or ram_rated_mtps > 0)
    and (ram_actual_mtps is null or ram_actual_mtps > 0)
  );

alter table run_summaries
  add constraint run_summaries_nonnegative_metrics_check
  check (
    avg_fps >= 0
    and p1_low_fps >= 0
    and p01_low_fps >= 0
    and (min_fps is null or min_fps >= 0)
    and (max_fps is null or max_fps >= 0)
    and frametime_p50_ms >= 0
    and frametime_p95_ms >= 0
    and frametime_p99_ms >= 0
    and stutter_count >= 0
    and sample_count >= 0
    and duration_seconds >= 0
    and (gpu_avg_power is null or gpu_avg_power >= 0)
    and (gpu_avg_clock_mhz is null or gpu_avg_clock_mhz >= 0)
  );

alter table run_summaries
  add constraint run_summaries_pct_metrics_check
  check (
    (gpu_avg_load is null or (gpu_avg_load >= 0 and gpu_avg_load <= 100))
    and (vram_peak_pct is null or (vram_peak_pct >= 0 and vram_peak_pct <= 100))
    and (cpu_avg_load is null or (cpu_avg_load >= 0 and cpu_avg_load <= 100))
  );

alter table verification_jobs
  add constraint verification_jobs_attempts_nonnegative_check
  check (attempts >= 0);
