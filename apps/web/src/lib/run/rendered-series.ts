/**
 * §22.12 — the chart's rendered-interval series.
 *
 * The stat tiles switch to the rendered rate; the trace underneath them has to
 * switch with it. A frame-time chart still drawn over presented frames beneath
 * rendered numbers contradicts itself, and the rendered stream has its own
 * median, so it has its own stutter threshold too.
 *
 * The x axis keeps the REAL time base. Each rendered interval is placed at the
 * timestamp of the rendered present that opened it (`startRows`), not at a
 * synthetic `0, Δ, 2Δ…` offset — a synthetic base would silently compress a
 * capture whose rendered presents are unevenly spaced, which is precisely the
 * shape frame generation produces.
 */

import { coalesceRenderedIntervals } from "@heimdall/parsers";
import { buildFrameSeriesFromColumns, type FrameSeries } from "./frame-series";

/**
 * Build the rendered-only series from a decoded presented series.
 *
 * Returns `undefined` when the series carries no present-type column — the
 * caller should not have offered the toggle in that case, so this is a
 * belt-and-braces guard rather than a state the UI relies on.
 *
 * Note this deliberately does NOT reuse the run's stored analysis: that blob
 * carries the summary, not the per-interval arrays a chart needs, and
 * recomputing from the same decoded columns through the same coalescer is what
 * keeps the drawn trace and the printed numbers in agreement.
 */
export function buildRenderedSeries(series: FrameSeries): FrameSeries | undefined {
  const { presentTypes } = series;
  if (presentTypes === undefined) return undefined;

  const { intervals, startRows } = coalesceRenderedIntervals(series.frameTimes, presentTypes);
  if (intervals.length === 0) return undefined;

  // Gather each interval's own start timestamp. `buildFrameSeriesFromColumns`
  // normalizes its `times` argument IN PLACE, so this must be a fresh array —
  // handing it `series.times` would corrupt the presented series the toggle
  // switches back to.
  const times = new Float64Array(startRows.length);
  for (let i = 0; i < startRows.length; i++) {
    times[i] = series.times[startRows[i]!]!;
  }

  // Sensor stats are deliberately dropped. Per-present busy times do not
  // survive coalescing (the run page forces the overlay off in rendered mode),
  // and avg GPU load / peak VRAM describe the whole capture either way — they
  // are read from the presented series, which is still in hand.
  return buildFrameSeriesFromColumns(times, intervals);
}
