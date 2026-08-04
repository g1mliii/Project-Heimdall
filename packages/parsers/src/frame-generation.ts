/**
 * Rendered-frame analysis (§22.12) — the honest rate under frame generation.
 *
 * A generated frame is not a rendered frame, so `avgFps`, the 1% lows and the
 * stutter count of a frame-generated run all describe something other than what
 * they say. Measured on an RX 9070 XT, Cyberpunk 2077 reported 243.9 avg FPS
 * with frame generation on against 130.7 with it off. This module computes the
 * second, rendered-only rate so a report can answer both "how fast did it
 * render" and "how smooth did it feel".
 *
 * ── Why this is not a filter ────────────────────────────────────────────────
 *
 * A rendered summary is NOT the subset of rows with `generated === false`.
 * `frameTimeMs` is an INTERVAL, so dropping the generated rows drops their
 * durations too and the rate comes out unchanged: on the measured capture,
 * 7,120 rendered rows over their own 4.10 ms mean interval recompute to
 * `1000 × 7120 / (7120 × 4.10)` = 243.9 FPS — bit-for-bit the presented number.
 * The rendered series is the set of intervals BETWEEN CONSECUTIVE RENDERED
 * PRESENTS, so a generated present's time is absorbed into the interval that
 * contains it.
 *
 * Arithmetic check against the measured pair: 7,120 rendered presents → 7,119
 * intervals over ~58.4 s → 121.9 rendered FPS, against 130.7 measured with
 * frame generation off. The −6.7% residual is the cost of running frame
 * generation itself, which consumes base render budget. That agreement is the
 * only evidence this algorithm measures what it claims — see
 * `docs/frame-generation.md`.
 *
 * ── The forward convention ──────────────────────────────────────────────────
 *
 * `frameTimeMs` is FORWARD-looking on the only profile that can carry frame
 * type. Verified on `fixtures/presentmon/v2-amd-real.csv`:
 * `10058.6817 + 8.6357 = 10067.3174`, exactly the next row's `CPUStartTime`, on
 * four consecutive rows of real hardware. So `d[i] = t[i+1] − t[i]`: an
 * accumulator STARTS at a rendered present and closes when it REACHES the next
 * one (exclusive). The backward reading is off by one row per boundary —
 * harmless on a strictly alternating stream, but it moves p95/p99, the lows and
 * the stutter count on any irregular one. `parsePresentMon` gates its frame-type
 * lookup on the v2 profile so this convention is structural, not documentary.
 *
 * Do NOT rederive intervals from `time_ms` deltas to dodge the convention:
 * `computeFrameParquetSummary` drops `times` to shed 4 MiB, and
 * `buildFrameSeriesFromColumns` normalizes `times` in place, so the server and
 * the browser would be working from different arrays — losing bit-identity
 * exactly where it is needed.
 */

import {
  FRAME_GENERATION_EVIDENCE,
  INGEST_LIMITS,
  PRESENT_FRAME_TYPE,
  percentileOfSorted,
  type RunSummary,
} from "@heimdall/shared";
import { computeRunSummaryFromFrameTimes } from "./metrics";

/**
 * Fewest rendered intervals that can carry a rendered rate.
 *
 * Deliberately the same bar as `INGEST_LIMITS.minFramesPerRun` — "below this a
 * capture is noise, not a benchmark" — applied to the rendered stream. It is
 * not set higher to protect the tail statistics: `computeRunSummaryFromFrameTimes`
 * already grades 0.1%-low confidence by sample count, so a short rendered stream
 * reports itself as low-confidence rather than being suppressed entirely.
 */
export const MIN_RENDERED_INTERVALS = INGEST_LIMITS.minFramesPerRun;

/** Per-row present-type codes, one byte each (`PRESENT_FRAME_TYPE`). */
export type PresentTypeColumn = Uint8Array;

export interface PresentTypeCounts {
  /** Presents the capture labelled application-rendered. */
  renderedCount: number;
  /** Presents the capture labelled engine-generated (interpolated). */
  generatedCount: number;
  /** Presents carrying no frame-type information at all. */
  unknownCount: number;
}

export interface RenderedIntervals extends PresentTypeCounts {
  /** Intervals between consecutive rendered presents (ms). */
  intervals: Float64Array;
  /**
   * Each interval's originating row — the rendered present it starts at. Lets
   * the browser rebuild the chart on the real time base instead of a synthetic
   * `0, Δ, 2Δ…` axis, which would silently compress the run.
   */
  startRows: Uint32Array;
  /**
   * Time before the first rendered present, and time from the last rendered
   * present to the end of the capture. Neither is bounded by two rendered
   * presents, so neither can become an interval — but they are reported so the
   * accounting closes: `Σ intervals + leadingMs + trailingMs` equals the total
   * of every `frameTimeMs` in the stream.
   */
  leadingMs: number;
  trailingMs: number;
}

/**
 * Coalesce a present stream into the intervals between consecutive rendered
 * presents.
 *
 * `unknown` rows inside an evidence-bearing run are ABSORBED into the enclosing
 * interval rather than treated as rendered: the time elapsed, we just don't know
 * what bounded it. Claiming an unlabelled present was rendered would invent the
 * very evidence this phase exists to stop manufacturing.
 *
 * Pure and total. `presentTypes` shorter or longer than `frameTimesMs` is a
 * programmer error and throws, exactly as `computeRunSummaryFromFrameTimes`
 * throws on an empty array.
 */
export function coalesceRenderedIntervals(
  frameTimesMs: ArrayLike<number>,
  presentTypes: PresentTypeColumn,
): RenderedIntervals {
  const n = frameTimesMs.length;
  if (presentTypes.length !== n) {
    throw new RangeError("coalesceRenderedIntervals requires matching column lengths");
  }

  let renderedCount = 0;
  let generatedCount = 0;
  for (let i = 0; i < n; i++) {
    const type = presentTypes[i]!;
    if (type === PRESENT_FRAME_TYPE.rendered) renderedCount++;
    else if (type === PRESENT_FRAME_TYPE.generated) generatedCount++;
  }
  const unknownCount = n - renderedCount - generatedCount;

  // n rendered presents bound n−1 intervals: the last one opens an interval
  // nothing closes, so its time is trailing, not measured.
  const intervalCount = Math.max(0, renderedCount - 1);
  const intervals = new Float64Array(intervalCount);
  const startRows = new Uint32Array(intervalCount);

  let leadingMs = 0;
  let trailingMs = 0;
  let accumulatorMs = 0;
  let startRow = -1;
  let written = 0;

  for (let i = 0; i < n; i++) {
    const frameTimeMs = frameTimesMs[i]!;
    if (presentTypes[i] === PRESENT_FRAME_TYPE.rendered) {
      if (startRow >= 0) {
        // Reached the next rendered present: the accumulator closes here
        // (exclusive of this row's own forward-looking duration).
        intervals[written] = accumulatorMs;
        startRows[written] = startRow;
        written++;
      }
      startRow = i;
      accumulatorMs = frameTimeMs;
      continue;
    }
    // Generated or unlabelled. Before the first rendered present its time is
    // leading; after one, it belongs to the interval in progress.
    if (startRow < 0) leadingMs += frameTimeMs;
    else accumulatorMs += frameTimeMs;
  }
  // Whatever is still in the accumulator was opened by the last rendered
  // present and never closed by another.
  if (startRow >= 0) trailingMs = accumulatorMs;

  return {
    intervals,
    startRows,
    renderedCount,
    generatedCount,
    unknownCount,
    leadingMs,
    trailingMs,
  };
}

/**
 * Why a rendered rate is unavailable, or that it is.
 *
 * A discriminated union rather than a nullable summary, mirroring
 * `vramCapacitySchema` ("a discrete total, or a typed reason it is
 * unavailable"). The server decides WHY once and the UI reads one field, so
 * §22.12's "stated, not silently omitted" is structural rather than a copy
 * convention three surfaces have to remember.
 */
export type RenderedFrameAnalysis =
  | ({
      state: "available";
      /** The rendered-only summary, from the SAME canonical metric code. */
      summary: RunSummary;
    } & PresentTypeCounts)
  /**
   * No present was ever labelled generated. A `FrameType` column full of
   * `Application` is exactly what an uninstrumented driver produces, so it is
   * indistinguishable from no column at all — only an observed `true` carries
   * information (§22.11).
   */
  | { state: "no-frame-type-evidence" }
  /**
   * The capture reports frame type and shows no generated frames.
   *
   * No rendered summary is produced — and NOT because it would duplicate the
   * presented one, but because it would not: the coalescer returns
   * `d[0..n−2]`, differing from the presented summary in the 3rd–4th
   * significant figure. Two numbers claiming to be the same rate and
   * disagreeing slightly is worse than one number.
   */
  | ({ state: "no-generated-frames" } & PresentTypeCounts)
  /** Fewer than {@link MIN_RENDERED_INTERVALS} intervals — too few to time. */
  | ({ state: "too-few-rendered-presents" } & PresentTypeCounts);

/**
 * Compute the rendered-frame analysis for a present stream.
 *
 * The intervals feed straight into the EXISTING
 * {@link computeRunSummaryFromFrameTimes}: no percentile, low or stutter
 * definition is rederived here. That is what makes server/browser agreement
 * structural rather than merely tested — the rendered summary is the canonical
 * summary of a different series, not a second implementation of the same math.
 *
 * `generatedFrameCount` is passed as 0: within the rendered series every sample
 * IS a rendered interval, so the resulting `generatedFramePct` is 0 by
 * construction and means "none of these intervals is generated" — not "this run
 * has no generated frames". Callers must never surface it as the latter; the
 * run page swaps the tile for an interpolated-presents count in rendered mode.
 */
export function computeRenderedFrameAnalysis(
  frameTimesMs: ArrayLike<number>,
  presentTypes: PresentTypeColumn,
): RenderedFrameAnalysis {
  const coalesced = coalesceRenderedIntervals(frameTimesMs, presentTypes);
  const { renderedCount, generatedCount, unknownCount, intervals } = coalesced;
  const counts = { renderedCount, generatedCount, unknownCount };

  if (generatedCount === 0) {
    // Nothing was ever labelled generated. Distinguish "the capture told us
    // nothing at all" from "the capture told us, and the answer was none".
    return renderedCount === 0
      ? { state: "no-frame-type-evidence" }
      : { state: "no-generated-frames", ...counts };
  }
  if (intervals.length < MIN_RENDERED_INTERVALS) {
    return { state: "too-few-rendered-presents", ...counts };
  }

  return {
    state: "available",
    summary: computeRunSummaryFromFrameTimes(intervals, 0),
    ...counts,
  };
}

/**
 * Low-tail present-time statistics (§22.13) — CHARACTERISATION ONLY.
 *
 * Detects nothing and annotates nothing. These numbers accumulate in
 * `runs.present_time_profile`, stay off the wire, and exist so a frame-
 * generation rule can one day be calibrated on more than one vendor. See
 * `FRAME_GENERATION_EVIDENCE` in `@heimdall/shared` and
 * `docs/frame-generation.md`.
 *
 * The signal is sub-millisecond presents: the measured RX 9070 XT pair showed a
 * 0.32 ms minimum with frame generation on against 3.11 ms with it off, and a
 * 0.32 ms present is not a plausible rendered frame at that resolution.
 *
 * Within-run rather than ratio-vs-aggregate, on purpose: an aggregate baseline
 * is already contaminated by the undeclared runs it is meant to find, it is
 * inert below the §17.4/§18.2 cold-start threshold so it does nothing at
 * current data volume, and 2× is not a clean constant (DLSS4 multi-frame
 * generation is 3–4×, and the multiplier drifts with base framerate).
 */
export interface PresentTimeProfile {
  minFrameTimeMs: number;
  /** Nearest-rank low-tail percentiles, matching the canonical convention. */
  p0_1Ms: number;
  p1Ms: number;
  p5Ms: number;
  subMillisecondPresentCount: number;
  subMillisecondPresentFraction: number;
  /**
   * Fraction of adjacent present PAIRS where both are sub-millisecond. A burst
   * of interpolated presents clusters; scattered fast presents do not.
   */
  adjacentSubMillisecondPairFraction: number;
  /**
   * Median ÷ minimum present time — the statistic to lead the writeup with,
   * because it is SCALE-FREE: independent of base framerate, resolution and
   * title, which answers §22.13's own objection that the multiplier drifts. On
   * the measured pair it separates 5×: 4.10/0.32 = 12.8 with frame generation
   * on against 7.65/3.11 = 2.46 with it off.
   *
   * On n = 1 it is still worth nothing, and the docs say so in those words.
   */
  medianOverMinRatio: number;
}

/**
 * Compute the present-time profile for a frame stream.
 *
 * Sorts its own copy rather than threading the sorted buffer out of
 * `computeRunSummaryFromFrameTimes`: that function is the canonical §11.5
 * recompute and is not worth perturbing for a characterisation statistic. The
 * extra sort runs once per verification, alongside a full Parquet decode.
 */
export function computePresentTimeProfile(
  frameTimesMs: ArrayLike<number>,
): PresentTimeProfile | undefined {
  const n = frameTimesMs.length;
  if (n === 0) return undefined;

  const sorted = new Float64Array(n);
  let subMillisecondPresentCount = 0;
  let adjacentSubMillisecondPairs = 0;
  let previousWasSubMillisecond = false;
  for (let i = 0; i < n; i++) {
    const frameTimeMs = frameTimesMs[i]!;
    sorted[i] = frameTimeMs;
    const isSubMillisecond = frameTimeMs <= FRAME_GENERATION_EVIDENCE.subMillisecondPresentMs;
    if (isSubMillisecond) {
      subMillisecondPresentCount++;
      if (previousWasSubMillisecond) adjacentSubMillisecondPairs++;
    }
    previousWasSubMillisecond = isSubMillisecond;
  }
  // Explicit comparator, matching `summarizeSortedFrameTimes` — the canonical
  // sort this profile's percentiles must agree with.
  sorted.sort((a, b) => a - b);

  const minFrameTimeMs = sorted[0]!;
  const medianMs = percentileOfSorted(sorted, 50);
  return {
    minFrameTimeMs,
    p0_1Ms: percentileOfSorted(sorted, 0.1),
    p1Ms: percentileOfSorted(sorted, 1),
    p5Ms: percentileOfSorted(sorted, 5),
    subMillisecondPresentCount,
    subMillisecondPresentFraction: subMillisecondPresentCount / n,
    // n presents form n−1 adjacent pairs; a single-present capture forms none.
    adjacentSubMillisecondPairFraction: n > 1 ? adjacentSubMillisecondPairs / (n - 1) : 0,
    // `parseFrameParquetFrameTimeMs` enforces >= MIN_FRAME_TIME_MS (0.01), so
    // the minimum is never zero and this division is always defined.
    medianOverMinRatio: medianMs / minFrameTimeMs,
  };
}
