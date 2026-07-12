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
  /** 1 = generated (DLSS3/FSR3/XeSS), 0 = app-rendered or unknown. */
  generated: Uint8Array;
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

export function buildFrameSeries(frames: readonly FrameSample[]): FrameSeries {
  const count = frames.length;
  const times = new Float64Array(count);
  const frameTimes = new Float64Array(count);
  const generated = new Uint8Array(count);

  let gpuLoadSum = 0;
  let gpuLoadCount = 0;
  let peakVram: number | undefined;
  let previousFrameEndMs = 0;
  let minFrameTimeMs = Infinity;
  let maxFrameTimeMs = 0;

  for (let i = 0; i < count; i++) {
    const frame = frames[i]!;
    // Stored timestamps never decrease, but can repeat or overlap a long prior
    // frame. Normalize every overlapping start to the prior frame end so chart
    // times remain strictly increasing for binary-search windowing.
    const frameStartMs = Math.max(frame.timeMs, previousFrameEndMs);
    times[i] = frameStartMs;
    frameTimes[i] = frame.frameTimeMs;
    previousFrameEndMs = frameStartMs + frame.frameTimeMs;
    if (frame.frameTimeMs < minFrameTimeMs) minFrameTimeMs = frame.frameTimeMs;
    if (frame.frameTimeMs > maxFrameTimeMs) maxFrameTimeMs = frame.frameTimeMs;
    if (frame.generated === true) generated[i] = 1;
    if (frame.gpuLoadPct !== undefined) {
      gpuLoadSum += frame.gpuLoadPct;
      gpuLoadCount++;
    }
    if (frame.vramUsedMb !== undefined && (peakVram === undefined || frame.vramUsedMb > peakVram)) {
      peakVram = frame.vramUsedMb;
    }
  }

  return {
    count,
    times,
    frameTimes,
    generated,
    totalDurationMs: previousFrameEndMs,
    minFrameTimeMs: count === 0 ? 0 : minFrameTimeMs,
    maxFrameTimeMs,
    ...(gpuLoadCount > 0 ? { avgGpuLoadPct: gpuLoadSum / gpuLoadCount } : {}),
    ...(peakVram !== undefined ? { peakVramUsedMb: peakVram } : {}),
  };
}
