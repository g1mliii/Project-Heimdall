/**
 * Columnar frame series for the run-page chart (§13.1).
 *
 * `FrameSample[]` is convenient for parsing but slow to scan 500k times per
 * zoom gesture; the chart wants flat typed arrays built once. Sensor stats the
 * hardware panel shows (avg GPU load, peak VRAM) are folded in here so the
 * frames array is walked exactly once.
 */

import type { FrameSample } from "@heimdall/shared";

export interface FrameSeries {
  count: number;
  /** Monotonic frame start positions on the chart x axis (ms). */
  times: Float64Array;
  frameTimes: Float64Array;
  /** Furthest frame end on the x axis, including every frame duration. */
  totalDurationMs: number;
  /** Fastest/slowest frame time across the capture (0 when empty) — the chart
   * y-domain reads these instead of re-scanning frameTimes. */
  minFrameTimeMs: number;
  maxFrameTimeMs: number;
  /** Mean GPU load over frames that reported it; undefined when none did. */
  avgGpuLoadPct?: number;
  /** Peak VRAM over frames that reported it; undefined when none did. */
  peakVramUsedMb?: number;
}

export interface FrameSeriesSensorStats {
  avgGpuLoadPct?: number;
  peakVramUsedMb?: number;
}

/**
 * Complete a chart series from validated columnar timing data. `sourceTimes`
 * is normalized in place, so callers can avoid an extra full-size allocation
 * after decoding a large Parquet projection.
 */
export function buildFrameSeriesFromColumns(
  sourceTimes: Float64Array,
  frameTimes: Float64Array,
  sensorStats: FrameSeriesSensorStats = {},
): FrameSeries {
  if (sourceTimes.length !== frameTimes.length) {
    throw new RangeError("frame time columns must have the same length");
  }

  const count = frameTimes.length;

  let previousFrameEndMs = 0;
  let minFrameTimeMs = Infinity;
  let maxFrameTimeMs = 0;

  for (let i = 0; i < count; i++) {
    // Stored timestamps never decrease, but can repeat or overlap a long prior
    // frame. Normalize every overlapping start to the prior frame end so chart
    // times remain strictly increasing for binary-search windowing.
    const frameStartMs = Math.max(sourceTimes[i]!, previousFrameEndMs);
    const frameTimeMs = frameTimes[i]!;
    sourceTimes[i] = frameStartMs;
    previousFrameEndMs = frameStartMs + frameTimeMs;
    if (frameTimeMs < minFrameTimeMs) minFrameTimeMs = frameTimeMs;
    if (frameTimeMs > maxFrameTimeMs) maxFrameTimeMs = frameTimeMs;
  }

  return {
    count,
    times: sourceTimes,
    frameTimes,
    totalDurationMs: previousFrameEndMs,
    minFrameTimeMs: count === 0 ? 0 : minFrameTimeMs,
    maxFrameTimeMs,
    ...sensorStats,
  };
}

export function buildFrameSeries(frames: readonly FrameSample[]): FrameSeries {
  const count = frames.length;
  const times = new Float64Array(count);
  const frameTimes = new Float64Array(count);

  let gpuLoadSum = 0;
  let gpuLoadCount = 0;
  let peakVram: number | undefined;

  for (let i = 0; i < count; i++) {
    const frame = frames[i]!;
    times[i] = frame.timeMs;
    frameTimes[i] = frame.frameTimeMs;
    if (frame.gpuLoadPct !== undefined) {
      gpuLoadSum += frame.gpuLoadPct;
      gpuLoadCount++;
    }
    if (frame.vramUsedMb !== undefined && (peakVram === undefined || frame.vramUsedMb > peakVram)) {
      peakVram = frame.vramUsedMb;
    }
  }

  return buildFrameSeriesFromColumns(times, frameTimes, {
    ...(gpuLoadCount > 0 ? { avgGpuLoadPct: gpuLoadSum / gpuLoadCount } : {}),
    ...(peakVram !== undefined ? { peakVramUsedMb: peakVram } : {}),
  });
}
