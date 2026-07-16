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

/** Bump when the inclusion contract changes so downstream aggregates can pin it. */
export const COHORT_DEFINITION_VERSION = 1;

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
  // Phase 7 adds a versioned representative predicate to both the typed and
  // SQL contracts; until then no raw set member may enter a pooled cohort.
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
    // Phase 7 replaces this with one versioned representative per set.
    predicates.push(`${alias}.benchmark_set_id is null`);
  }
  return predicates.join(" and ");
}
