/**
 * Spike-preserving downsampling for the frame-time trace (§13.1).
 *
 * One bucket per ~CSS pixel of chart width; every bucket emits its min AND max
 * sample, so a stutter spike can never be averaged away — the max of the
 * bucket it falls in survives by construction. At most `2 × buckets` points
 * reach the canvas regardless of capture size (500k-frame worst case,
 * INGEST_LIMITS.maxFramesPerRun). When the visible window is already small the
 * raw samples pass through untouched, so a fully-zoomed-in view is exact.
 */

import { bisectLeft, bisectRight } from "d3-array";

export interface VisibleRange {
  /** First index whose timestamp is >= t0 (inclusive). */
  start: number;
  /** One past the last index whose timestamp is <= t1 (exclusive). */
  end: number;
}

/** Binary-search the index window covering visible times `[t0, t1]`. */
export function sliceVisible(times: Float64Array, t0: number, t1: number): VisibleRange {
  return {
    start: bisectLeft(times, t0),
    end: bisectRight(times, t1),
  };
}

export interface DownsampledSeries {
  /** Timestamps of the emitted points, non-decreasing. */
  x: Float64Array;
  /** Values of the emitted points (same length as x). */
  y: Float64Array;
  /** True when the window passed through without binning (exact view). */
  raw: boolean;
}

/**
 * Min/max-bin `values[start..end)` into `buckets` equal TIME slices between
 * the window's first and last timestamp. Buckets are time-based (not
 * index-based) so points land in the pixel column they will be drawn in even
 * when frame times vary wildly across the window.
 */
export function downsampleMinMax(
  times: Float64Array,
  values: Float64Array,
  start: number,
  end: number,
  buckets: number,
): DownsampledSeries {
  const n = end - start;
  if (n <= 0 || buckets <= 0) {
    return { x: new Float64Array(0), y: new Float64Array(0), raw: true };
  }
  if (n <= 2 * buckets) {
    return { x: times.slice(start, end), y: values.slice(start, end), raw: true };
  }

  const t0 = times[start]!;
  const t1 = times[end - 1]!;
  const span = t1 - t0;
  if (span <= 0) {
    // Degenerate window (all identical timestamps): emit global min + max.
    return { x: times.slice(start, start + 1), y: values.slice(start, start + 1), raw: true };
  }

  // Per-bucket extrema, tracked by index so output stays in time order.
  const minIndex = new Int32Array(buckets).fill(-1);
  const maxIndex = new Int32Array(buckets).fill(-1);
  for (let i = start; i < end; i++) {
    let b = Math.floor(((times[i]! - t0) / span) * buckets);
    if (b >= buckets) b = buckets - 1;
    const value = values[i]!;
    if (minIndex[b] === -1 || value < values[minIndex[b]!]!) minIndex[b] = i;
    if (maxIndex[b] === -1 || value > values[maxIndex[b]!]!) maxIndex[b] = i;
  }

  const x = new Float64Array(2 * buckets);
  const y = new Float64Array(2 * buckets);
  let out = 0;
  for (let b = 0; b < buckets; b++) {
    const lo = minIndex[b]!;
    if (lo === -1) continue; // empty time slice
    const hi = maxIndex[b]!;
    const first = Math.min(lo, hi);
    const second = Math.max(lo, hi);
    x[out] = times[first]!;
    y[out] = values[first]!;
    out++;
    if (second !== first) {
      x[out] = times[second]!;
      y[out] = values[second]!;
      out++;
    }
  }
  return { x: x.slice(0, out), y: y.slice(0, out), raw: false };
}
