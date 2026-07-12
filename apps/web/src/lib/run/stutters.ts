/**
 * Stutter detection for chart markers (§13.1) — the SAME rule the canonical
 * summary counted with, via `stutterThresholdMs` from @heimdall/parsers, so
 * the dots on the chart and `summary.stutterCount` can never disagree.
 * Median is nearest-rank (`sorted[ceil(n/2)-1]`) to match `computeRunSummary`
 * exactly; an interpolating quantile would drift on even-length runs.
 */

import { stutterThresholdMs } from "@heimdall/parsers";

/** Nearest-rank median over frame times (copy-sorts; input untouched). */
export function medianFrameTimeMs(frameTimes: Float64Array): number {
  const n = frameTimes.length;
  if (n === 0) return 0;
  const sorted = Float64Array.from(frameTimes).sort();
  return sorted[Math.ceil(n / 2) - 1]!;
}

/**
 * Indices of frames whose time exceeds the shared STUTTER threshold.
 *
 * Pass `medianMs` when the caller already has the run's median frame time
 * (`RunSummary.frameTimeP50Ms` is the identical nearest-rank value) to skip a
 * full O(n log n) re-sort of up to 500k frames on every run load.
 */
export function findStutterIndices(frameTimes: Float64Array, medianMs?: number): Uint32Array {
  const n = frameTimes.length;
  if (n === 0) return new Uint32Array(0);
  const thresholdMs = stutterThresholdMs(medianMs ?? medianFrameTimeMs(frameTimes));
  const found: number[] = [];
  for (let i = 0; i < n; i++) {
    if (frameTimes[i]! > thresholdMs) found.push(i);
  }
  return Uint32Array.from(found);
}
