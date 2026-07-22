/**
 * Cohort integrity assessment (§18) — the durable, versioned record of why a
 * validated run is excluded from a pooled distribution. This is separate from
 * lifecycle status: writing an assessment never changes a run's visibility (an
 * outlier stays listed and reachable; only `flagged` hides, and that is a
 * different, reproducible-failure decision).
 *
 * The distribution read excludes statistical outliers LIVE, so a curve is always
 * current. This module persists the same verdict for audit/debug (§18.5) and to
 * surface "excluded as a statistical outlier" on a run page. Its SQL mirrors
 * the shared classifier's documented median/MAD and sigma-fallback math.
 *
 * Recompute is bounded per game — a game's observation set is a small aggregate,
 * and outlier membership only changes when that game's cohorts change — so this
 * never sweeps the whole table.
 */

import {
  AGGREGATE_EXCLUSION,
  COHORT_ASSESSMENT_VERSION,
  OUTLIER,
  cohortEligibilitySql,
  cohortObservationsSql,
  comparabilityKeySql,
  type AggregateExclusionReason,
} from "@heimdall/shared";

import { getPool, query, RETRY_BACKOFF_SECS_SQL, type Queryable } from "../db";

export interface CohortAssessment {
  assessmentVersion: number;
  /** null → included in its cohort; otherwise the scoped exclusion reason. */
  exclusionReason: AggregateExclusionReason | null;
  evaluatedAt: string;
}

export interface CohortAssessmentResult {
  /** Observations classified (one per non-set run + one representative per set). */
  assessed: number;
  /** Of those, how many are statistical outliers excluded from their curve. */
  excluded: number;
}

/**
 * Shared Postgres form of {@link statisticalOutlierMask}. `base` must expose
 * `ck`, `run_id`, `value`, and `observation_count`; callers own the observation
 * selection, while this keeps the MAD/sigma verdict identical for the live
 * curve and the durable assessment lane.
 */
export function cohortOutlierClassificationSql(base = "base"): string {
  return `centres as materialized (
       select ck,
              avg(value) as mean_value,
              stddev_pop(value) as sigma,
              percentile_disc(0.5) within group (order by value) as median_value
         from ${base}
        where value is not null
        group by ck
     ), deviations as materialized (
       select ${base}.ck,
              ${base}.run_id,
              ${base}.value,
              ${base}.observation_count,
              centres.mean_value,
              centres.sigma,
              centres.median_value,
              abs(${base}.value - centres.median_value) as absolute_deviation
         from ${base}
         join centres using (ck)
        where ${base}.value is not null
     ), spreads as materialized (
       select ck,
              min(mean_value) as mean_value,
              min(sigma) as sigma,
              min(median_value) as median_value,
              percentile_disc(0.5) within group (order by absolute_deviation) as mad
         from deviations
        group by ck
     ), classified as materialized (
       select deviations.run_id,
              deviations.ck,
              deviations.value,
              case
                when deviations.observation_count < ${OUTLIER.minSampleSize} then false
                when spreads.mad > 0 then abs(
                  (${OUTLIER.madScale} * (deviations.value - spreads.median_value)) / spreads.mad
                ) > ${OUTLIER.madZScoreThreshold}
                when spreads.sigma > 0 then abs(
                  (deviations.value - spreads.mean_value) / spreads.sigma
                ) > ${OUTLIER.sigmaThreshold}
                else false
              end as is_outlier
         from deviations
         join spreads using (ck)
     )`;
}

/**
 * Recompute and persist the cohort assessment for every observation of one
 * game, grouping by the shared comparability key and running the MAD/sigma
 * outlier rule per exact bucket over avg FPS — the same metric the set
 * representative is chosen by. Below the cold-start threshold a bucket produces
 * no outlier verdicts, so a sparse cohort is recorded as "not enough comparable
 * data," never accused.
 */
export async function recomputeGameCohortAssessments(
  gameId: string,
  db: Queryable = getPool(),
): Promise<CohortAssessmentResult> {
  const rows = await query<{ assessed: string | number; excluded: string | number }>(
    // The complete classification stays in Postgres. A popular game can have
    // hundreds of thousands of observations; materializing every id/value in a
    // maintenance worker defeats the queue's bounded-memory contract. This
    // mirrors `statisticalOutlierMask`: nearest-rank median/MAD, then a
    // population-sigma fallback only when MAD has zero spread.
    `with observations as materialized ${cohortObservationsSql({ scopeSql: "r.game_id = $1" })},
     base as materialized (
       select values.*,
              count(*) over (partition by ck) as observation_count
         from (
           select ${comparabilityKeySql("r")} as ck,
                  r.id as run_id,
                  s.avg_fps::double precision as value
             from observations obs
             join runs r on r.id = obs.run_id
             join run_summaries s on s.run_id = r.id
         ) values
     ), ${cohortOutlierClassificationSql()}, assessment_candidates as materialized (
       -- Keep a durable no-outlier assessment for every observation, including
       -- an unexpected null metric value that the statistical calculation
       -- correctly omits.
       select base.run_id,
              case when classified.is_outlier
                then '${AGGREGATE_EXCLUSION.statisticalOutlier}'
                else null
              end as exclusion_reason
         from base
         left join classified on classified.run_id = base.run_id
     ), stale_assessments as (
       delete from run_cohort_assessments assessment
        where (
            assessment.game_id = $1
            -- The Phase 8 schema migration deliberately leaves legacy rows nullable and
            -- lets the bounded game scanner converge them. This fallback
            -- keeps their cleanup correct during that transition.
            or (
              assessment.game_id is null
              and exists (
                select 1 from runs run
                 where run.id = assessment.run_id
                   and run.game_id = $1
              )
            )
          )
          and not exists (
            select 1 from observations observation where observation.run_id = assessment.run_id
          )
     ), candidate_summary as materialized (
       select count(*) as assessed,
              count(*) filter (where exclusion_reason = '${AGGREGATE_EXCLUSION.statisticalOutlier}') as excluded
         from assessment_candidates
     ), upserted as (
       insert into run_cohort_assessments (run_id, game_id, assessment_version, exclusion_reason, evaluated_at)
       select run_id, $1::bigint, $2, exclusion_reason, now()
         from assessment_candidates
       on conflict (run_id) do update
          set game_id = excluded.game_id,
              assessment_version = excluded.assessment_version,
              exclusion_reason = excluded.exclusion_reason
        -- Recomputes are queued on every cohort-changing write. Avoid a full
        -- table rewrite when the resulting durable verdict is unchanged.
        where run_cohort_assessments.assessment_version is distinct from excluded.assessment_version
           or run_cohort_assessments.game_id is distinct from excluded.game_id
           or run_cohort_assessments.exclusion_reason is distinct from excluded.exclusion_reason
     )
     select assessed, excluded
       from candidate_summary`,
    [gameId, COHORT_ASSESSMENT_VERSION],
    db,
  );
  const result = rows[0];
  return { assessed: Number(result?.assessed ?? 0), excluded: Number(result?.excluded ?? 0) };
}

/**
 * Enqueue the bounded initial/version-change sweep (§18.5). Live run, summary,
 * and canonical-identity mutations enqueue their own game through migration
 * 0032; this cursor is only the resumable safety net for existing data and a
 * new assessment version. It scans indexed game ids rather than expanding every
 * benchmark-set member on every maintenance pass.
 */
export async function enqueueStaleCohortAssessments(
  { limit = 200 }: { limit?: number } = {},
  db: Queryable = getPool(),
): Promise<number> {
  const boundedLimit = Math.max(1, Math.min(limit, 5_000));
  await db.query(
    `insert into cohort_assessment_scan_state (singleton, assessment_version, last_game_id)
     values (true, $1, 0)
     on conflict (singleton) do update
        set assessment_version = excluded.assessment_version,
            last_game_id = 0,
            updated_at = now()
      where cohort_assessment_scan_state.assessment_version < excluded.assessment_version`,
    [COHORT_ASSESSMENT_VERSION],
  );
  const rows = await query<{ game_id: string }>(
    `with scan_state as materialized (
       select last_game_id
         from cohort_assessment_scan_state
        where singleton = true and assessment_version = $1
        for update
     ), game_slice as materialized (
       select game.id
         from games game
         cross join scan_state
        where game.id > scan_state.last_game_id
        order by game.id
        limit $2
     ), candidates as materialized (
       select game_slice.id
         from game_slice
        where exists (
            select 1
              from runs r
             where r.game_id = game_slice.id
               and ${cohortEligibilitySql("r", { allowBenchmarkSetMembers: true })}
          )
     ), advanced as (
       update cohort_assessment_scan_state scan
          set last_game_id = greatest(
                scan.last_game_id,
                coalesce((select max(id) from game_slice), scan.last_game_id)
              ),
              updated_at = now()
        where scan.singleton = true and scan.assessment_version = $1
     )
     insert into cohort_assessment_jobs (game_id)
     select id from candidates
     -- A live job is left exactly as it is (the primary key already dedups). A
     -- TOMBSTONE revives only when the assessment version has moved past the one
     -- it died under: a rule change earns one fresh bounded retry, while a game
     -- that is permanently broken under the CURRENT rules stays quarantined
     -- rather than reviving every pass and starving the rest of the sweep.
     on conflict (game_id) do update
        set attempts = 0,
            locked_at = null,
            last_error = null,
            failed_at = null,
            failed_assessment_version = null,
            not_before = now()
      where cohort_assessment_jobs.failed_at is not null
        and cohort_assessment_jobs.failed_assessment_version < $1
     returning game_id`,
    [COHORT_ASSESSMENT_VERSION, boundedLimit],
    db,
  );
  return rows.length;
}

export interface ClaimedCohortAssessmentJob {
  gameId: string;
  /** Claim count INCLUDING this one, so the caller can cap retries. */
  attempts: number;
  /** Enqueue generation observed by this lease; protects a newer mutation. */
  enqueueGeneration: number;
}

/**
 * Atomically claim the next due cohort-assessment job under a lease, skipping
 * terminal tombstones. The claim increments `attempts`, so a game that always
 * throws backs off (see {@link failCohortAssessmentJob}) instead of re-claiming
 * on a fixed lease forever and starving the bounded per-pass budget.
 */
export async function claimNextCohortAssessmentJob(
  { leaseMinutes = 10 }: { leaseMinutes?: number } = {},
  db: Queryable = getPool(),
): Promise<ClaimedCohortAssessmentJob | null> {
  const rows = await query<{ game_id: string; attempts: number; enqueue_generation: string | number }>(
    `update cohort_assessment_jobs job
        set locked_at = now(),
            not_before = now() + make_interval(mins => $1),
            attempts = job.attempts + 1
      where job.game_id = (
        select candidate.game_id
          from cohort_assessment_jobs candidate
         where candidate.failed_at is null
           and candidate.not_before <= now()
         order by candidate.not_before, candidate.game_id
         for update skip locked
         limit 1
      )
      returning job.game_id, job.attempts, job.enqueue_generation`,
    [leaseMinutes],
    db,
  );
  const row = rows[0];
  return row
    ? {
        gameId: row.game_id,
        attempts: row.attempts,
        enqueueGeneration: Number(row.enqueue_generation),
      }
    : null;
}

/**
 * Delete a completed cohort-assessment job. The attempt and enqueue-generation
 * guards make this a no-op when a lease was re-claimed or a newer mutation
 * arrived while it was running. In the latter case, release the newer job
 * immediately so that fresh work is replayed instead of being discarded.
 */
export async function completeCohortAssessmentJob(
  job: Pick<ClaimedCohortAssessmentJob, "gameId" | "attempts" | "enqueueGeneration">,
  db: Queryable = getPool(),
): Promise<boolean> {
  const result = await db.query(
    `delete from cohort_assessment_jobs
      where game_id = $1
        and attempts = $2
        and enqueue_generation = $3
        and locked_at is not null
        and failed_at is null`,
    [job.gameId, job.attempts, job.enqueueGeneration],
  );
  if ((result.rowCount ?? 0) > 0) return true;

  await db.query(
    `update cohort_assessment_jobs
        set locked_at = null,
            not_before = now()
      where game_id = $1
        and attempts = $2
        and enqueue_generation > $3
        and locked_at is not null
        and failed_at is null`,
    [job.gameId, job.attempts, job.enqueueGeneration],
  );
  return false;
}

/**
 * Record a failed recompute. A non-terminal failure releases the lease and
 * pushes `not_before` out by the shared {@link RETRY_BACKOFF_SECS_SQL} curve;
 * a terminal one leaves a tombstone stamped with the assessment version it died
 * under, quarantining the game until the rules change rather than letting it
 * consume a slot on every pass.
 */
export async function failCohortAssessmentJob(
  job: Pick<ClaimedCohortAssessmentJob, "gameId" | "attempts" | "enqueueGeneration">,
  error: string,
  terminal: boolean,
  db: Queryable = getPool(),
): Promise<boolean> {
  const result = await db.query(
    `update cohort_assessment_jobs
        set locked_at = null,
            last_error = $3,
            failed_at = case when $4::boolean then now() else null end,
            failed_assessment_version = case when $4::boolean then $5::integer else null end,
            not_before = case
              when $4::boolean then now()
              else now() + make_interval(secs => ${RETRY_BACKOFF_SECS_SQL})
            end
      where game_id = $1
        and attempts = $2
        and enqueue_generation = $6
        and locked_at is not null
        and failed_at is null`,
    [
      job.gameId,
      job.attempts,
      error.slice(0, 2_000),
      terminal,
      COHORT_ASSESSMENT_VERSION,
      job.enqueueGeneration,
    ],
  );
  if ((result.rowCount ?? 0) > 0) return true;

  // A failure from the old snapshot must not tombstone a mutation that landed
  // while it was running. Release that newer generation for a clean replay.
  const released = await db.query(
    `update cohort_assessment_jobs
        set locked_at = null,
            not_before = now()
      where game_id = $1
        and attempts = $2
        and enqueue_generation > $3
        and locked_at is not null
        and failed_at is null`,
    [job.gameId, job.attempts, job.enqueueGeneration],
  );
  return (released.rowCount ?? 0) > 0;
}

/** The stored cohort assessment for a run, or null when never assessed. */
export async function readCohortAssessment(
  runId: string,
  db: Queryable = getPool(),
): Promise<CohortAssessment | null> {
  const rows = await query<{
    assessment_version: number;
    exclusion_reason: AggregateExclusionReason | null;
    evaluated_at: Date;
  }>(
    `select assessment_version, exclusion_reason, evaluated_at
       from run_cohort_assessments
      where run_id = $1`,
    [runId],
    db,
  );
  const row = rows[0];
  if (!row) return null;
  return {
    assessmentVersion: row.assessment_version,
    exclusionReason: row.exclusion_reason,
    evaluatedAt: row.evaluated_at.toISOString(),
  };
}
