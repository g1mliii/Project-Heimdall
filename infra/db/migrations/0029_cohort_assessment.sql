-- Phase 7.5 §18 — durable cohort integrity assessment. This is deliberately
-- SEPARATE from runs.status (lifecycle): a run stays `validated` and
-- individually visible while an assessment row may exclude it from ONE pooled
-- distribution (unprofiled / telemetry-unassessable / statistical-outlier). An
-- assessment NEVER changes visibility — hiding stays reserved for `flagged`.
--
-- The distribution read excludes statistical outliers live (self-updating as a
-- cohort grows), so this table is the durable audit/debug record (§18.5) and
-- the source for surfacing "excluded as a statistical outlier" on a run page.

create table run_cohort_assessments (
  run_id            text primary key references runs (id) on delete cascade,
  -- The rule generation this verdict was computed under, so a stored assessment
  -- records its own basis and a bounded recompute can find stale ones.
  assessment_version integer not null
                     constraint run_cohort_assessments_version_positive_check
                     check (assessment_version > 0),
  -- null = included in its cohort; otherwise the scoped aggregate-exclusion
  -- reason. Mirrors AGGREGATE_EXCLUSION in @heimdall/shared.
  exclusion_reason  text
                    constraint run_cohort_assessments_reason_check
                    check (
                      exclusion_reason is null
                      or exclusion_reason in (
                        'unprofiled', 'telemetry-unassessable', 'statistical-outlier'
                      )
                    ),
  evaluated_at      timestamptz not null default now()
);

-- Bounded recompute finds runs assessed under an older rule version without a
-- full-table scan, mirroring the reprocess capability/driver access paths.
create index run_cohort_assessments_stale_idx
  on run_cohort_assessments (assessment_version, run_id);

-- Fast "which excluded runs, and why" reads for a cohort audit.
create index run_cohort_assessments_reason_idx
  on run_cohort_assessments (exclusion_reason)
  where exclusion_reason is not null;
