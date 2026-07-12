import { describe, expect, it } from "vitest";
import { makeSyntheticFrames } from "@heimdall/shared";

import { buildFrameSeries, buildFrameSeriesFromColumns } from "./frame-series";

describe("buildFrameSeries", () => {
  it("transposes frames into typed columns with sensor stats", () => {
    const frames = makeSyntheticFrames({ seed: 7, count: 500 });
    const series = buildFrameSeries(frames);

    expect(series.count).toBe(500);
    expect(series.times[0]).toBe(frames[0]!.timeMs);
    expect(series.frameTimes[499]).toBe(frames[499]!.frameTimeMs);
    expect(series.totalDurationMs).toBeCloseTo(
      frames[499]!.timeMs + frames[499]!.frameTimeMs,
      12,
    );
    expect(series.avgGpuLoadPct).toBeGreaterThan(90);
    expect(series.avgGpuLoadPct).toBeLessThan(100);
    expect(series.peakVramUsedMb).toBe(Math.max(...frames.map((f) => f.vramUsedMb!)));
  });

  it("omits sensor stats when no frame reports the sensor", () => {
    const series = buildFrameSeries([
      { timeMs: 0, frameTimeMs: 10 },
      { timeMs: 10, frameTimeMs: 12 },
    ]);
    expect(series.avgGpuLoadPct).toBeUndefined();
    expect(series.peakVramUsedMb).toBeUndefined();
    expect(series.totalDurationMs).toBe(22);
  });

  it("reconstructs strictly increasing chart times from repeated timestamps", () => {
    const series = buildFrameSeries([
      { timeMs: 0, frameTimeMs: 10 },
      { timeMs: 0, frameTimeMs: 12 },
      { timeMs: 0, frameTimeMs: 8 },
    ]);

    expect(Array.from(series.times)).toEqual([0, 10, 22]);
    expect(series.totalDurationMs).toBe(30);
  });

  it("clamps overlapping source timestamps so chart times stay strictly increasing", () => {
    const series = buildFrameSeries([
      { timeMs: 0, frameTimeMs: 5 },
      { timeMs: 5, frameTimeMs: 20 },
      { timeMs: 5, frameTimeMs: 3 },
      { timeMs: 6, frameTimeMs: 4 },
    ]);

    expect(Array.from(series.times)).toEqual([0, 5, 25, 28]);
    expect(series.totalDurationMs).toBe(32);
  });

  it("completes decoded timing columns in place without frame objects", () => {
    const times = Float64Array.from([0, 5, 5, 6]);
    const frameTimes = Float64Array.from([5, 20, 3, 4]);

    const series = buildFrameSeriesFromColumns(times, frameTimes, {
      avgGpuLoadPct: 95,
      peakVramUsedMb: 12_000,
    });

    expect(series.times).toBe(times);
    expect(Array.from(series.times)).toEqual([0, 5, 25, 28]);
    expect(series.totalDurationMs).toBe(32);
    expect(series.avgGpuLoadPct).toBe(95);
    expect(series.peakVramUsedMb).toBe(12_000);
  });

  it("handles an empty frame list", () => {
    const series = buildFrameSeries([]);
    expect(series.count).toBe(0);
    expect(series.totalDurationMs).toBe(0);
  });
});
