/**
 * Cohort integrity assessment (§18) — a versioned layer that is deliberately
 * SEPARATE from a run's lifecycle status (§18.1). A run can be `validated` (safe
 * to share, individually visible) yet still be excluded from ONE pooled
 * distribution: it may lack a complete methodology profile, expose no
 * frame-aligned sensors for a sensor-derived metric, or sit far enough from its
 * exact cohort to be a statistical outlier.
 *
 * These are scoped AGGREGATE-exclusion reasons, never a visibility change. An
 * outlier is dropped from the curve but never hidden — hiding stays reserved for
 * a reproducible server/integrity failure (`flagged`), which is a different
 * decision made elsewhere.
 */

import { OUTLIER } from "./integrity";
import { madOutlierMask } from "./statistics";

/** Bump when the assessment rules change, so a stored verdict records its basis. */
export const COHORT_ASSESSMENT_VERSION = 1;

/** Why a validated run is nonetheless outside a specific pooled aggregate. */
export const AGGREGATE_EXCLUSION = {
  /** No complete declared methodology profile — cannot be placed in a bucket. */
  unprofiled: "unprofiled",
  /** A sensor-derived metric's telemetry is absent or not frame-aligned (§18.2). */
  telemetryUnassessable: "telemetry-unassessable",
  /** Far enough from its exact cohort to be a statistical outlier (§18.2). */
  statisticalOutlier: "statistical-outlier",
} as const;

export type AggregateExclusionReason =
  (typeof AGGREGATE_EXCLUSION)[keyof typeof AGGREGATE_EXCLUSION];

/**
 * Statistical-outlier mask over ONE comparability cohort's independent
 * representative values, aligned to input order.
 *
 * Below {@link OUTLIER.minSampleSize} it returns all-false: too few comparable
 * runs to call anything an outlier (§18.2/§18.5). The caller records "not enough
 * comparable data," never an outlier verdict — outlier rejection stays inert
 * until a cohort is large enough for the MAD statistic to mean something. As a
 * cohort grows past the threshold this naturally begins excluding, and every
 * recomputation reflects the current membership.
 */
export function statisticalOutlierMask(values: readonly number[]): boolean[] {
  if (values.length < OUTLIER.minSampleSize) return values.map(() => false);
  return madOutlierMask(values);
}
