-- Phase 7.5 §18.5 — bounded, resumable recalculation of cohort assessments. A
-- dedup queue of games whose cohort assessment is stale because a new run
-- landed, a canonical alias merged runs in, or the assessment rule generation
-- advanced. The distribution READ already excludes outliers live, so this lane
-- only keeps the durable audit record (0029) current — never the request path.
--
-- One row per game (primary key dedups), claimed with a lease like the other
-- job tables. The enqueue is index-bounded and the recompute stamps every
-- observation at the current assessment version, so the queue converges instead
-- of re-enqueuing the same game forever.
--
-- Retry accounting mirrors reprocess_jobs (0026): every claim increments
-- `attempts` so a permanently crashing game backs off instead of re-claiming on
-- a fixed lease forever, and a terminal failure leaves a tombstone rather than
-- being deleted. Without this a single game whose recompute always throws would
-- consume one of the five per-pass slots on every pass, indefinitely.

create table cohort_assessment_jobs (
  game_id     bigint primary key references games (id) on delete cascade,
  not_before  timestamptz not null default now(),
  attempts    integer not null default 0
              constraint cohort_assessment_jobs_attempts_nonnegative_check
              check (attempts >= 0),
  locked_at   timestamptz,
  last_error  text,
  failed_at   timestamptz,
  -- The assessment version a terminal failure died under. A tombstone blocks
  -- only THAT version, so a rule-generation bump earns one fresh bounded retry
  -- while a permanently broken game stays quarantined at the current version.
  failed_assessment_version integer,
  created_at  timestamptz not null default now(),
  constraint cohort_assessment_jobs_failure_versioned_check
    check ((failed_at is null) = (failed_assessment_version is null))
);

-- Claim order: due jobs first, oldest first. Partial, because a claim never
-- considers a tombstone — this keeps quarantined games out of the index rather
-- than filtering them on every claim.
create index cohort_assessment_jobs_claim_idx
  on cohort_assessment_jobs (not_before, game_id)
  where failed_at is null;

-- No index is added for the enqueue's anti-join on run_cohort_assessments: run_id
-- is already that table's PRIMARY KEY (0029), so the `a.run_id = obs.run_id`
-- probe is a unique index scan and `assessment_version` is one heap fetch away.
-- A (run_id, assessment_version) index would only add write amplification to a
-- table rewritten once per observation per recompute pass.
