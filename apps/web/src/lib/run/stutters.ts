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

/** Indices of frames whose time exceeds the shared STUTTER threshold. */
export function findStutterIndices(frameTimes: Float64Array): Uint32Array {
  const n = frameTimes.length;
  if (n === 0) return new Uint32Array(0);
  const thresholdMs = stutterThresholdMs(medianFrameTimeMs(frameTimes));
  const found: number[] = [];
  for (let i = 0; i < n; i++) {
    if (frameTimes[i]! > thresholdMs) found.push(i);
  }
  return Uint32Array.from(found);
}
