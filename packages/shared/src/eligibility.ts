/**
 * Phase 6.7 cohort-read readiness. This is intentionally separate from a run's
 * lifecycle status: a run can be valid and individually shareable while still
 * lacking the identity, methodology, or capability evidence needed for a
 * public pooled cohort.
 */

import {
  CAPABILITY_MANIFEST_VERSION,
} from "./constants";
import {
  comparabilityProfileSql,
  missingComparabilityProfileFields,
} from "./comparability";
import { aggregateEligibilitySql, RUN_STATUS, RUN_VISIBILITY } from "./visibility";
import type { MethodologyManifest, RunStatus, RunVisibility } from "./types";

export const COHORT_EXCLUSION = {
  notPublic: "not-public",
  notValidated: "not-validated",
  unresolvedGame: "unresolved-game",
  unresolvedGpu: "unresolved-gpu",
  unprofiled: "unprofiled",
  capabilityUnestablished: "capability-unestablished",
  warmup: "warmup",
  setMember: "set-member",
} as const;

export type CohortExclusionReason =
  (typeof COHORT_EXCLUSION)[keyof typeof COHORT_EXCLUSION];

/**
 * Bump when the inclusion contract changes so downstream aggregates can pin it.
 *
 * v2 (§17.0.2): a benchmark set no longer contributes zero observations — it
 * contributes exactly one representative (its median non-warm-up member), so a
 * repeated set weighs once instead of not at all. See {@link cohortObservationsSql}.
 */
export const COHORT_DEFINITION_VERSION = 2;

export interface CohortEligibilityInput {
  visibility: RunVisibility;
  status: RunStatus;
  gameId: string | null;
  gpuId: string | null;
  methodologyManifest: MethodologyManifest | undefined;
  methodologyManifestVersion: number | null;
  capabilityManifestVersion: number | null;
  isWarmup: boolean;
  benchmarkSetId: string | null;
}

/** Empty means the run is ready to contribute one independent cohort observation. */
export function cohortExclusionReasons(
  input: CohortEligibilityInput,
): CohortExclusionReason[] {
  const reasons: CohortExclusionReason[] = [];
  if (input.visibility !== RUN_VISIBILITY.public) {
    reasons.push(COHORT_EXCLUSION.notPublic);
  }
  if (input.status !== RUN_STATUS.validated) {
    reasons.push(COHORT_EXCLUSION.notValidated);
  }
  if (input.gameId === null) {
    reasons.push(COHORT_EXCLUSION.unresolvedGame);
  }
  if (input.gpuId === null) {
    reasons.push(COHORT_EXCLUSION.unresolvedGpu);
  }
  if (
    input.methodologyManifestVersion === null ||
    missingComparabilityProfileFields(input.methodologyManifest).length > 0
  ) {
    reasons.push(COHORT_EXCLUSION.unprofiled);
  }
  if (
    input.capabilityManifestVersion === null ||
    input.capabilityManifestVersion < CAPABILITY_MANIFEST_VERSION
  ) {
    reasons.push(COHORT_EXCLUSION.capabilityUnestablished);
  }
  if (input.isWarmup) {
    reasons.push(COHORT_EXCLUSION.warmup);
  }
  // A raw set member is not an INDEPENDENT observation: its whole set collapses
  // to one representative (§17.0.2, {@link cohortObservationsSql}), so it never
  // enters the ungrouped observation stream on its own. This gate describes that
  // per-run stream; the set-level representative is chosen in SQL, not here.
  if (input.benchmarkSetId !== null) {
    reasons.push(COHORT_EXCLUSION.setMember);
  }
  return reasons;
}

export interface CohortEligibilitySqlOptions {
  /** Auxiliary benchmark-set variance reads retain warm-ups for their count. */
  allowWarmups?: boolean;
  /** Auxiliary set reads inspect raw members before Phase 7 chooses one representative. */
  allowBenchmarkSetMembers?: boolean;
  /**
   * Require a capability manifest at the CURRENT version. Public cohorts must
   * (a metric's denominator depends on proven sensors), but an owner-facing read
   * of a run's own benchmark set must not: a legacy run whose manifest predates
   * the current version — exactly the population Phase 6.7 backfills — would
   * otherwise lose its repeatability panel until an operator runs the CLI-only
   * full lane. Comparability itself does not depend on the manifest version.
   */
  requireCurrentCapabilityManifest?: boolean;
}

/**
 * Canonical SQL predicate for a run that can feed a public cohort.
 *
 * The aliases and options are developer-authored, never request input. This
 * fragment only adds conjuncts to the partial-index predicates copied in
 * migrations 0020/0021/0022; relaxing those predicates would prevent Postgres
 * from using the aggregate hot-path indexes.
 */
export function cohortEligibilitySql(
  alias = "runs",
  options: CohortEligibilitySqlOptions = {},
): string {
  const predicates = [
    aggregateEligibilitySql(alias),
    `${alias}.game_id is not null`,
    `${alias}.gpu_hardware_id is not null`,
    // This helper is the code source mirrored by the 0020/0021/0022 partial
    // index predicates; keeping it as a conjunct preserves index implication.
    comparabilityProfileSql(alias),
  ];
  if (options.requireCurrentCapabilityManifest ?? true) {
    // The is-not-null conjunct is NOT redundant next to `>= N`. In a WHERE
    // clause it would be — null and false both drop the row — but this fragment
    // is also SELECTed as a value (the TS↔SQL parity property test), and
    // `true and null` is null, not false. Keep it so the predicate always
    // returns a real boolean.
    predicates.push(`${alias}.capability_manifest_version is not null`);
    predicates.push(`${alias}.capability_manifest_version >= ${CAPABILITY_MANIFEST_VERSION}`);
  }
  if (!options.allowWarmups) {
    predicates.push(`${alias}.is_warmup = false`);
  }
  if (!options.allowBenchmarkSetMembers) {
    // Single-run observations exclude set members; the set contributes one
    // representative through {@link cohortObservationsSql} instead.
    predicates.push(`${alias}.benchmark_set_id is null`);
  }
  return predicates.join(" and ");
}

/**
 * The cohort OBSERVATION set (§17.0.2), one row per independent observation with
 * a single `run_id`, ready to be joined to `runs`/`run_summaries` for whatever
 * comparability grouping and metric a distribution needs:
 *
 * - every eligible non-set run contributes itself, and
 * - every eligible benchmark set contributes exactly ONE representative — its
 *   median non-warm-up member by avg FPS — so a repeated set (or 30 duplicate
 *   uploads under one set) weighs once, never once per file.
 *
 * The representative is a real member row (selected by `row_number`, not an
 * interpolated value) so a caller can read any metric column from it and still
 * get a coherent single run. The nearest-rank median position
 * `rn = (cnt + 1) / 2` matches {@link computeSetRepresentative}'s TS median, so
 * the two observation sets agree run-for-run (the §19.2 parity test).
 *
 * Returns a parenthesized derived table; callers alias it and join on `run_id`.
 * `options` are developer-authored, never request input.
 *
 * `scopeSql` is a predicate over the `r` alias pushed INSIDE both union branches.
 * It exists for correctness of plan, not of result: the set branch ranks with a
 * window function, which blocks qual pushdown, so an outer `where r.game_id = $1`
 * would still make the branch scan and sort every eligible set member in the
 * whole catalog. Single-title callers must pass their game predicate here.
 */
export function cohortObservationsSql(
  options: CohortEligibilitySqlOptions & { scopeSql?: string } = {},
): string {
  const { scopeSql, ...eligibility } = options;
  const scope = scopeSql ? `${scopeSql} and ` : "";
  const individualPredicate = cohortEligibilitySql("r", {
    ...eligibility,
    allowBenchmarkSetMembers: false,
  });
  const memberPredicate = cohortEligibilitySql("r", {
    ...eligibility,
    allowWarmups: false,
    allowBenchmarkSetMembers: true,
  });
  return `(
    select r.id as run_id
      from runs r
     where ${scope}${individualPredicate}
    union all
    select ranked.run_id
      from (
        select r.id as run_id,
               row_number() over (
                 partition by r.benchmark_set_id order by s.avg_fps, r.id
               ) as rn,
               count(*) over (partition by r.benchmark_set_id) as member_count
          from runs r
          join run_summaries s on s.run_id = r.id
         where ${scope}r.benchmark_set_id is not null
           and ${memberPredicate}
      ) ranked
     where ranked.rn = (ranked.member_count + 1) / 2
  )`;
}
