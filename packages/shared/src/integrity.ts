/**
 * Statistical-integrity and canonical-summary thresholds, as named constants
 * (IMPLEMENTATION_PLAN §1.3). Phase 7 (§18) consumes these; Phase 1 (§2.3) may
 * extend this file. Centralized so the integrity math has a single source of truth.
 * See docs/integrity-and-privacy.md §2.
 */

/** Statistical outlier rejection — Phase 7 §18.2. */
export const OUTLIER = {
  /** Scales median absolute deviation to its normal-distribution equivalent. */
  madScale: 0.6745,
  /** Modified z-score (MAD-based) magnitude above which a run is an outlier. */
  madZScoreThreshold: 3.5,
  /** Fallback sigma multiplier when MAD is degenerate (zero spread). */
  sigmaThreshold: 3,
  /**
   * Minimum runs for a given game + canonical GPU before distributions and
   * automatic outlier hiding activate. Below this, show raw runs labelled
   * "insufficient data" — never a bell curve (§17.4) — and outlier rejection
   * stays inert (§18.2).
   */
  minSampleSize: 30,
} as const;

/**
 * Server recompute threshold (§11.5). Per-frame telemetry remains explanatory:
 * the available CPU/GPU utilisation fields are whole-machine aggregates and
 * cannot safely establish that a run is fabricated.
 */
export const PHYSICS = {
  /** Allowed fractional gap between the client-submitted and server-recomputed summary. */
  recomputeTolerance: 0.01,
} as const;
