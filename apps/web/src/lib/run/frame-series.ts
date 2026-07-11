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
  /** Frame start timestamps (ms from capture start), monotonic. */
  times: Float64Array;
  frameTimes: Float64Array;
  /** 1 = generated (DLSS3/FSR3/XeSS), 0 = app-rendered or unknown. */
  generated: Uint8Array;
  /** End of the capture on the x axis: last start + last frame time. */
  totalDurationMs: number;
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

  for (let i = 0; i < count; i++) {
    const frame = frames[i]!;
    times[i] = frame.timeMs;
    frameTimes[i] = frame.frameTimeMs;
    if (frame.generated === true) generated[i] = 1;
    if (frame.gpuLoadPct !== undefined) {
      gpuLoadSum += frame.gpuLoadPct;
      gpuLoadCount++;
    }
    if (frame.vramUsedMb !== undefined && (peakVram === undefined || frame.vramUsedMb > peakVram)) {
      peakVram = frame.vramUsedMb;
    }
  }

  const last = frames[count - 1];
  return {
    count,
    times,
    frameTimes,
    generated,
    totalDurationMs: last === undefined ? 0 : last.timeMs + last.frameTimeMs,
    ...(gpuLoadCount > 0 ? { avgGpuLoadPct: gpuLoadSum / gpuLoadCount } : {}),
    ...(peakVram !== undefined ? { peakVramUsedMb: peakVram } : {}),
  };
}
