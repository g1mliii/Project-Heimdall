-- Phase 7.5 §17.8.0 — run-level diagnostics watermark. Before this, the full
-- reprocess lane found stale-rule runs by joining `diagnostics`, so it only
-- reached runs that ALREADY stored a finding for a bumped code; a clean run a
-- newly-firing rule would flag was never re-evaluated, and "no finding" was
-- indistinguishable from "never evaluated at this rule version" — which §17.8's
-- aggregate-rate denominators must tell apart.
--
-- The fix mirrors the driver lane's run-level watermark (runs.driver_evaluated_at):
-- a run records the diagnostics rule GENERATION its findings were evaluated
-- under, so the lane can enqueue any run below the current generation (clean or
-- not), and a rate can count "evaluated at the current generation" precisely.

alter table runs add column diagnostics_rule_generation integer;
-- Freshness for §17.8 display; the generation above is the enqueue/denominator key.
alter table runs add column diagnostics_evaluated_at timestamptz;

-- Existing validated/flagged runs were evaluated under the first (current)
-- generation, so record that. New runs are stamped at verification time; runs
-- still pending are left null and excluded by the reprocessable-status guard.
update runs
   set diagnostics_rule_generation = 1,
       diagnostics_evaluated_at = now()
 where status in ('validated', 'flagged');

-- Bounded access path for "runs at or below the current generation", mirroring
-- runs_reprocess_capability_idx. NULLS FIRST because unstamped runs are the
-- highest-priority candidates, not excluded ones: a run that reaches 'flagged'
-- through failVerificationJob never passes applyVerificationResult, so it stays
-- reprocessable with a null watermark and the lane predicate must (and does)
-- carry an `is null` branch to reach it.
create index runs_diagnostics_generation_idx
  on runs (diagnostics_rule_generation nulls first, created_at, id)
  where frames_object_key is not null
    and status in ('validated', 'flagged');
