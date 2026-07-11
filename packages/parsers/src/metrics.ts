/**
 * Canonical metric computation (§9). This exact code runs in the browser for
 * the provisional client summary (Phase 4) and on the server for the canonical
 * recompute (Phase 7), so every definition is deterministic and closed-form:
 *
 * - percentiles are nearest-rank (`sorted[ceil(p/100*n)-1]`) — no
 *   interpolation, so recomputes are bit-identical;
 * - X% lows are `1000 / mean(slowest ceil(n*X/100) frames)`;
 * - a stutter is a frame with `frameTimeMs > STUTTER.medianMultiplier × median`
 *   AND `> STUTTER.minFrameTimeMs` (§9.1);
 * - 0.1%-low confidence is graded by sample count (§9.2).
 */

import {
  POINT_ONE_PERCENT_LOW_CONFIDENCE_FRAMES,
  STUTTER,
  type ConfidenceLevel,
  type FrameSample,
  type RunSummary,
} from "@heimdall/shared";

/** Nearest-rank percentile over an ascending-sorted array. */
function nearestRank(sortedAsc: readonly number[], p: number): number {
  const rank = Math.ceil((p / 100) * sortedAsc.length);
  return sortedAsc[Math.min(Math.max(rank, 1), sortedAsc.length) - 1]!;
}

/** Mean of the slowest `count` frames (the tail of the ascending sort). */
function slowestMeanMs(sortedAsc: readonly number[], count: number): number {
  let sum = 0;
  for (let i = sortedAsc.length - count; i < sortedAsc.length; i++) sum += sortedAsc[i]!;
  return sum / count;
}

function confidence(n: number): ConfidenceLevel {
  if (n >= POINT_ONE_PERCENT_LOW_CONFIDENCE_FRAMES.high) return "high";
  if (n >= POINT_ONE_PERCENT_LOW_CONFIDENCE_FRAMES.medium) return "medium";
  return "low";
}

/**
 * Compute the canonical `RunSummary` for a parsed frame stream.
 *
 * @throws {RangeError} on an empty array. Parsers cannot hand one over — the
 * `no-valid-frames` error fires first — so a throw here is a programmer error,
 * not a data condition, and stays an exception rather than a ParseResult.
 */
export function computeRunSummary(frames: readonly FrameSample[]): RunSummary {
  const n = frames.length;
  if (n === 0) throw new RangeError("computeRunSummary requires at least one frame");

  const sorted = new Array<number>(n);
  let sumMs = 0;
  let generatedCount = 0;
  for (let i = 0; i < n; i++) {
    const frame = frames[i]!;
    const frameTimeMs = frame.frameTimeMs;
    sorted[i] = frameTimeMs;
    sumMs += frameTimeMs;
    if (frame.generated === true) generatedCount++;
  }
  sorted.sort((a, b) => a - b);

  const medianMs = nearestRank(sorted, 50);
  let stutterCount = 0;
  for (const value of sorted) {
    if (value > STUTTER.medianMultiplier * medianMs && value > STUTTER.minFrameTimeMs) {
      stutterCount++;
    }
  }

  return {
    avgFps: (1000 * n) / sumMs,
    onePercentLowFps: 1000 / slowestMeanMs(sorted, Math.ceil(n * 0.01)),
    pointOnePercentLowFps: 1000 / slowestMeanMs(sorted, Math.ceil(n * 0.001)),
    frameTimeP50Ms: medianMs,
    frameTimeP95Ms: nearestRank(sorted, 95),
    frameTimeP99Ms: nearestRank(sorted, 99),
    stutterCount,
    generatedFramePct: generatedCount / n,
    pointOnePercentLowConfidence: confidence(n),
    sampleCount: n,
    durationSeconds: sumMs / 1000,
  };
}
