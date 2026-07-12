/**
 * Stutter detection for chart markers (§13.1) — the SAME rule the canonical
 * summary counted with, via `stutterThresholdMs` from @heimdall/parsers, so
 * the dots on the chart and `summary.stutterCount` can never disagree.
 * Median is nearest-rank (`sorted[ceil(n/2)-1]`) to match `computeRunSummary`
 * exactly; an interpolating quantile would drift on even-length runs.
 */

import { bisectLeft, quickselect } from "d3-array";
import { stutterThresholdMs } from "@heimdall/parsers";

/** Nearest-rank median over frame times (copy-selects; input untouched). */
export function medianFrameTimeMs(frameTimes: Float64Array): number {
  const n = frameTimes.length;
  if (n === 0) return 0;
  const values = Float64Array.from(frameTimes);
  const rank = Math.ceil(n / 2) - 1;
  quickselect(values, rank);
  return values[rank]!;
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

/**
 * Sample the visible stutters (`stutterIndices` in index window `[start, end)`)
 * into at most one representative marker per horizontal chart bucket, so a
 * hostile capture with thousands of spikes can't monopolize the paint. Returns
 * a `bucketCount`-length array of frame indices (or -1 for empty buckets).
 * Pairs with `downsampleMinMax` — both keep the chart to one mark per pixel.
 */
export function bucketStutterIndices(
  stutterIndices: Uint32Array,
  times: Float64Array,
  start: number,
  end: number,
  domainStart: number,
  domainEnd: number,
  bucketCount: number,
): Int32Array {
  const markers = new Int32Array(Math.max(1, Math.floor(bucketCount))).fill(-1);
  const span = domainEnd - domainStart;
  if (span <= 0) return markers;

  const first = bisectLeft(stutterIndices, start);
  const last = bisectLeft(stutterIndices, end);
  for (let bucket = 0; bucket < markers.length; bucket++) {
    const bucketStart = domainStart + (span * bucket) / markers.length;
    const bucketEnd = domainStart + (span * (bucket + 1)) / markers.length;
    let low = first;
    let high = last;
    while (low < high) {
      const middle = low + Math.floor((high - low) / 2);
      const index = stutterIndices[middle]!;
      if (times[index]! < bucketStart) low = middle + 1;
      else high = middle;
    }
    if (low === last) break;

    const index = stutterIndices[low]!;
    const time = times[index]!;
    if (time < bucketEnd || (bucket === markers.length - 1 && time <= domainEnd)) {
      markers[bucket] = index;
    }
  }
  return markers;
}
