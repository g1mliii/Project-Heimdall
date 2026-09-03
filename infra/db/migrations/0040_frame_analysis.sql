-- Phase 9.6 §22.12/§22.13 — rendered-frame analysis and present-time profile.
--
-- A generated frame is not a rendered frame, so avg FPS, the 1% lows and the
-- stutter count of a frame-generated run all describe something other than what
-- they say. `rendered_frame_analysis` stores the second, rendered-only summary
-- (or the typed reason there isn't one), computed server-side by the verify
-- worker from the stored Parquet.
--
-- Stored rather than derived at read time so the number is reachable from
-- /games, /compare and any list — not stranded on the run page. RunSummary,
-- summaryMismatch and the client upload contract are untouched: the §11.5
-- recompute gate does not move to accommodate this.
--
-- `present_time_profile` is §22.13 CHARACTERISATION ONLY: low-tail present-time
-- statistics that no rule reads, that annotate no run, and that deliberately
-- never reach the wire. The only frame-generation evidence this project holds
-- is one GPU, one title, one resolution; a threshold fitted to n = 1 that
-- accuses honest uploaders is the failure §0.5 exists to prevent.

alter table runs add column if not exists rendered_frame_analysis jsonb;
alter table runs add column if not exists present_time_profile jsonb;
-- The algorithm watermark that drives the reprocess lane below.
alter table runs add column if not exists frame_analysis_version integer;

-- DELIBERATELY NO BACKFILL — do not copy 0030's `update runs set ... = 1`.
--
-- 0030 could honestly stamp existing rows because those findings really HAD
-- been evaluated at generation 1. No existing row has ever had a frame analysis
-- computed, so stamping here would permanently hide the entire historical
-- corpus from the lane that exists to reach it. Leaving the watermark null makes
-- those rows the highest-priority candidates instead.
--
-- KNOW WHAT THIS COSTS BEFORE DEPLOYING. There is only one `full` reprocess
-- kind, so every run this lane enqueues is replayed through the whole verifier:
-- its Parquet is re-read from R2 and `applyReprocessResult` rewrites
-- `run_summaries`, `capability_manifest`, `generated_frame_tech`,
-- `settings_json` and every diagnostic row — not just the two columns added
-- here. Because 0030 DID backfill its watermark, the existing corpus is not
-- already queued by the diagnostics lane, so this migration is what makes it
-- eligible: the first sweeps after deploy re-verify every historical run.
--
-- That is safe (the replay never touches `status`, and version drift must never
-- manufacture a flag — see applyReprocessResult) and bounded per pass by the
-- enqueue limit, but it is real R2 egress and worker time proportional to the
-- whole corpus. Size the drain accordingly rather than discovering it in
-- production.

-- Bounded access path for "runs at or below the current analysis version",
-- mirroring runs_diagnostics_generation_idx. NULLS FIRST because unstamped runs
-- are the highest-priority candidates, not excluded ones: `null < $n` is null in
-- Postgres, so the lane predicate must (and does) carry an `is null` branch to
-- reach them — which is the entire pre-9.6 corpus plus any run that reached
-- 'flagged' through failVerificationJob without passing applyVerificationResult.
create index if not exists runs_frame_analysis_version_idx
  on runs (frame_analysis_version nulls first, created_at, id)
  where frames_object_key is not null
    and status in ('validated', 'flagged');
