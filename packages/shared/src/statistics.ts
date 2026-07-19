/**
 * Pure statistical primitives for Phase 7.5 cohort distributions and outlier
 * rejection (§17/§18). Deterministic and closed-form so a server recompute is
 * bit-identical to any other evaluation:
 *
 * - percentiles are nearest-rank (`sorted[ceil(p/100*n)-1]`) via
 *   {@link percentileOfSorted}, which `packages/parsers/src/metrics.ts` imports
 *   rather than restating — so a cohort marker and a run's own percentile are
 *   the same arithmetic by construction and can never disagree;
 * - outlier detection is MAD-based (robust to the very outliers it looks for),
 *   falling back to a population-sigma rule only when the MAD spread is
 *   degenerate (zero), exactly as {@link OUTLIER} documents.
 *
 * Thresholds come from {@link OUTLIER} — never hardcoded here — so the
 * anti-cheat math keeps its single source of truth in `integrity.ts`.
 */

import { OUTLIER } from "./integrity";

/** Ascending-sorted copy; never mutates the caller's array. */
function toSortedAsc(values: readonly number[]): number[] {
  return [...values].sort((a, b) => a - b);
}

/**
 * Nearest-rank percentile over an ALREADY ascending-sorted buffer — the repo's
 * single definition of the convention. `packages/parsers/src/metrics.ts` imports
 * this rather than restating it, so a cohort marker and a run's own percentile
 * are the same arithmetic by construction, not by comment. Accepts `ArrayLike`
 * so the parsers' `Float64Array` frame buffers need no copy.
 */
export function percentileOfSorted(sortedAsc: ArrayLike<number>, p: number): number {
  const rank = Math.ceil((p / 100) * sortedAsc.length);
  return sortedAsc[Math.min(Math.max(rank, 1), sortedAsc.length) - 1]!;
}

/** Arithmetic mean. Returns 0 for an empty input (no observations, no centre). */
export function mean(values: readonly number[]): number {
  if (values.length === 0) return 0;
  let sum = 0;
  for (const value of values) sum += value;
  return sum / values.length;
}

/** Nearest-rank percentile `p` in [0, 100]. Returns 0 for an empty input. */
export function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) return 0;
  return percentileOfSorted(toSortedAsc(values), p);
}

/** Nearest-rank median (p50), matching the metrics-module percentile convention. */
export function median(values: readonly number[]): number {
  return percentile(values, 50);
}

/**
 * Population standard deviation — we have the whole cohort/set, not a sample of
 * it, so this divides by n (matching `computeBenchmarkSetStats`). Returns 0 for
 * empty or singleton inputs.
 */
export function populationStdDev(values: readonly number[]): number {
  const n = values.length;
  if (n === 0) return 0;
  const m = mean(values);
  let acc = 0;
  for (const value of values) acc += (value - m) ** 2;
  return Math.sqrt(acc / n);
}

/** Standard deviation as a fraction of the mean; 0 when the mean is non-positive. */
export function coefficientOfVariation(values: readonly number[]): number {
  const m = mean(values);
  if (m <= 0) return 0;
  return populationStdDev(values) / m;
}

interface RobustScoring {
  /** Score per input value, aligned to input order. */
  scores: number[];
  /** Magnitude above which |score| marks an outlier, for the chosen method. */
  threshold: number;
}

/**
 * Robust per-value scoring with the MAD→sigma fallback in one place, so
 * {@link modifiedZScores} and {@link madOutlierMask} can never apply mismatched
 * scores and thresholds.
 *
 * - `mad`: modified z-score `0.6745·(x−median)/MAD`, threshold
 *   {@link OUTLIER.madZScoreThreshold}. The primary path.
 * - `sigma`: when MAD is 0 (e.g. a cluster of identical values with a few
 *   stragglers) the modified z-score is undefined, so fall back to a population
 *   z-score `(x−mean)/σ`, threshold {@link OUTLIER.sigmaThreshold}.
 * - `degenerate`: MAD and σ both 0 (every value identical) → all scores 0, no
 *   outliers possible.
 */
function robustScoring(values: readonly number[]): RobustScoring {
  if (values.length === 0) {
    return { scores: [], threshold: OUTLIER.madZScoreThreshold };
  }
  const med = percentileOfSorted(toSortedAsc(values), 50);
  const mad = percentileOfSorted(
    values.map((value) => Math.abs(value - med)).sort((a, b) => a - b),
    50,
  );
  if (mad > 0) {
    return {
      scores: values.map((value) => (OUTLIER.madScale * (value - med)) / mad),
      threshold: OUTLIER.madZScoreThreshold,
    };
  }
  const sigma = populationStdDev(values);
  if (sigma > 0) {
    const m = mean(values);
    return {
      scores: values.map((value) => (value - m) / sigma),
      threshold: OUTLIER.sigmaThreshold,
    };
  }
  return { scores: values.map(() => 0), threshold: OUTLIER.sigmaThreshold };
}

/**
 * Robust z-scores aligned to input order, using the MAD rule (or a population
 * z-score when MAD is degenerate). Pair with {@link madOutlierMask}, which
 * applies the method-correct threshold to these same scores.
 */
export function modifiedZScores(values: readonly number[]): number[] {
  return robustScoring(values).scores;
}

/**
 * Boolean per-value outlier mask over a single comparability cohort, aligned to
 * input order. Below {@link OUTLIER.minSampleSize} this still computes — callers
 * decide whether the cohort is large enough to act on a verdict (§18.2); this
 * primitive stays a pure function of its input.
 */
export function madOutlierMask(values: readonly number[]): boolean[] {
  const { scores, threshold } = robustScoring(values);
  return scores.map((score) => Math.abs(score) > threshold);
}

/** A histogram bin over the cohort's metric values. */
export interface DistributionBin {
  /** Inclusive lower edge of the bin (metric units). */
  lower: number;
  /** Upper edge; the final bin includes its upper edge so `max` always lands. */
  upper: number;
  count: number;
}

/** A labelled percentile position on the distribution axis. */
export interface DistributionMarker {
  /** Percentile in [0, 100]. */
  p: number;
  /** Nearest-rank value at that percentile. */
  value: number;
}

/** An empirical distribution ready for the bell-curve renderer (§17.1). */
export interface EmpiricalDistribution {
  bins: DistributionBin[];
  min: number;
  max: number;
  mean: number;
  /** Nearest-rank percentile markers (default p1/p50/p99). */
  markers: DistributionMarker[];
  sampleCount: number;
}

export interface EmpiricalDistributionOptions {
  /** Explicit bin count; defaults to a bounded √n rule. */
  binCount?: number;
  /** Percentile markers to compute; defaults to `[1, 50, 99]`. */
  percentileMarkers?: readonly number[];
}

/**
 * Bucket a cohort's metric values into equal-width bins with min/max/mean and
 * percentile markers for the distribution chart. Deterministic: identical input
 * yields identical bins. A single distinct value (or one observation) collapses
 * to one bin holding every sample — never an empty or NaN-edged histogram.
 */
export function empiricalDistributionBins(
  values: readonly number[],
  options: EmpiricalDistributionOptions = {},
): EmpiricalDistribution {
  const percentileMarkers = options.percentileMarkers ?? [1, 50, 99];

  if (values.length === 0) {
    const empty = percentileMarkers.map((p) => ({ p, value: 0 }));
    return { bins: [], min: 0, max: 0, mean: 0, markers: empty, sampleCount: 0 };
  }

  // Sorted once and reused for every marker, the range, and the binning — the
  // read model runs this per cohort, up to MAX_COHORTS times per request.
  const sorted = toSortedAsc(values);
  const markers: DistributionMarker[] = percentileMarkers.map((p) => ({
    p,
    value: percentileOfSorted(sorted, p),
  }));
  const min = sorted[0]!;
  const max = sorted[sorted.length - 1]!;

  // A degenerate range (every value identical) can't be split into edges, so
  // one bin holds the whole cohort.
  if (max === min) {
    return {
      bins: [{ lower: min, upper: max, count: sorted.length }],
      min,
      max,
      mean: mean(sorted),
      markers,
      sampleCount: sorted.length,
    };
  }

  const binCount =
    options.binCount ?? Math.max(1, Math.min(40, Math.ceil(Math.sqrt(sorted.length))));
  const width = (max - min) / binCount;
  const bins: DistributionBin[] = Array.from({ length: binCount }, (_, i) => ({
    lower: min + i * width,
    upper: i === binCount - 1 ? max : min + (i + 1) * width,
    count: 0,
  }));

  for (const value of sorted) {
    // Clamp guards floating-point drift at the top edge so `max` always lands
    // in the final bin rather than index `binCount`.
    const index = Math.min(binCount - 1, Math.floor((value - min) / width));
    bins[index]!.count++;
  }

  return { bins, min, max, mean: mean(sorted), markers, sampleCount: sorted.length };
}
