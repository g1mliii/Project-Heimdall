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

const EMPTY: DownsampledSeries = { x: new Float64Array(0), y: new Float64Array(0), raw: true };

/**
 * Degenerate window (all identical timestamps): retain its extrema just as
 * normal min/max bins do, rather than silently dropping a spike.
 */
function degenerateWindow(
  times: Float64Array,
  values: Float64Array,
  start: number,
  end: number,
): DownsampledSeries {
  let minIndex = -1;
  let maxIndex = -1;
  for (let i = start; i < end; i++) {
    const value = values[i]!;
    if (Number.isNaN(value)) continue;
    if (minIndex === -1 || value < values[minIndex]!) minIndex = i;
    if (maxIndex === -1 || value > values[maxIndex]!) maxIndex = i;
  }
  if (minIndex === -1) {
    return { x: new Float64Array(0), y: new Float64Array(0), raw: false };
  }
  const first = Math.min(minIndex, maxIndex);
  const second = Math.max(minIndex, maxIndex);
  return {
    x: second === first
      ? times.slice(first, first + 1)
      : Float64Array.from([times[first]!, times[second]!]),
    y: second === first
      ? values.slice(first, first + 1)
      : Float64Array.from([values[first]!, values[second]!]),
    raw: false,
  };
}

/**
 * Min/max-bin every column of `valueColumns` over `[start, end)` into `buckets`
 * equal TIME slices between the window's first and last timestamp. Buckets are
 * time-based (not index-based) so points land in the pixel column they will be
 * drawn in even when frame times vary wildly across the window.
 *
 * The columns are binned together because the bucket a sample falls in depends
 * only on its timestamp: the chart draws up to three traces off one `times`
 * array (frame time plus the §8.6.8 busy overlays) on every paint, and binning
 * them one at a time re-streamed a 500k-sample timestamp array — and redid the
 * same divide-and-floor per sample — once per trace.
 *
 * NaN samples mark frames the source did not report (§8.6.8 busy-time
 * columns). They never contribute to a bucket's extrema; a bucket whose every
 * sample is NaN emits one explicit NaN point so the painter breaks the line —
 * a missing sample must read as a hole, never as a value. Extrema are per
 * column, so each column emits its own points at its own sample times.
 */
export function downsampleMinMaxMulti(
  times: Float64Array,
  valueColumns: readonly Float64Array[],
  start: number,
  end: number,
  buckets: number,
): DownsampledSeries[] {
  const n = end - start;
  if (n <= 0 || buckets <= 0) return valueColumns.map(() => EMPTY);
  if (n <= 2 * buckets) {
    // Raw pass-through keeps NaN holes in place; the painter gaps on them. The
    // x slice is shared: every column is drawn against the same timestamps and
    // no consumer writes to it.
    const x = times.slice(start, end);
    return valueColumns.map((values) => ({ x, y: values.slice(start, end), raw: true }));
  }

  const t0 = times[start]!;
  const span = times[end - 1]! - t0;
  if (span <= 0) {
    return valueColumns.map((values) => degenerateWindow(times, values, start, end));
  }

  // Per-bucket extrema, tracked by index so output stays in time order. One
  // `buckets`-wide band per column, laid out end to end.
  const columns = valueColumns.length;
  const minIndex = new Int32Array(columns * buckets).fill(-1);
  const maxIndex = new Int32Array(columns * buckets).fill(-1);
  /** Buckets that held samples, real or not — distinguishes "empty time
   * slice" (skip silently) from "all samples unreported" (emit a gap). */
  const sawSample = new Uint8Array(buckets);
  for (let i = start; i < end; i++) {
    let b = Math.floor(((times[i]! - t0) / span) * buckets);
    if (b >= buckets) b = buckets - 1;
    sawSample[b] = 1;
    for (let c = 0; c < columns; c++) {
      const values = valueColumns[c]!;
      const value = values[i]!;
      if (Number.isNaN(value)) continue;
      const slot = c * buckets + b;
      if (minIndex[slot] === -1 || value < values[minIndex[slot]!]!) minIndex[slot] = i;
      if (maxIndex[slot] === -1 || value > values[maxIndex[slot]!]!) maxIndex[slot] = i;
    }
  }

  return valueColumns.map((values, c) => {
    const band = c * buckets;
    const x = new Float64Array(2 * buckets);
    const y = new Float64Array(2 * buckets);
    let out = 0;
    for (let b = 0; b < buckets; b++) {
      const lo = minIndex[band + b]!;
      if (lo === -1) {
        if (sawSample[b]) {
          // All-NaN bucket: one explicit gap point at the bucket's center.
          x[out] = t0 + ((b + 0.5) / buckets) * span;
          y[out] = Number.NaN;
          out++;
        }
        continue; // empty time slice
      }
      const hi = maxIndex[band + b]!;
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
  });
}

/**
 * Single-column {@link downsampleMinMaxMulti}. Convenience wrapper — the chart
 * always takes the multi-column path (frame time plus the optional busy
 * overlays), so this exists for the single-trace test cases.
 */
export function downsampleMinMax(
  times: Float64Array,
  values: Float64Array,
  start: number,
  end: number,
  buckets: number,
): DownsampledSeries {
  return downsampleMinMaxMulti(times, [values], start, end, buckets)[0]!;
}
