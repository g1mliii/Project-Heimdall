/**
 * Statistical-integrity & telemetry-physics thresholds, as named constants
 * (IMPLEMENTATION_PLAN §1.3). Phase 7 (§18) consumes these; Phase 1 (§2.3) may
 * extend this file. Centralized so the anti-cheat math has a single source of truth.
 * See docs/integrity-and-privacy.md §2.
 */

/** Statistical outlier rejection — Phase 7 §18.2. */
export const OUTLIER = {
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
 * Telemetry-physics checks (§18.1): flag runs whose reported FPS is physically
 * inconsistent with secondary sensors. A check is SKIPPED (never flags) when its
 * required sensor is absent (§7.3) — never flag on missing data.
 */
export const PHYSICS = {
  /** GPU load (%) below which sustained high FPS is implausible in GPU-bound titles. */
  implausiblyLowGpuLoadPct: 35,
  /** FPS above which low GPU load is treated as suspicious rather than a frame cap. */
  highFpsSuspicionThreshold: 240,
  /** Allowed fractional gap between the client-submitted and server-recomputed summary. */
  recomputeTolerance: 0.01,
} as const;
