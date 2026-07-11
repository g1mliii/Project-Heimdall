import { describe, expect, it } from "vitest";
import { computeRunSummary } from "@heimdall/parsers";
import { makeSyntheticFrames, SYNTHETIC_SPIKE_COUNT } from "@heimdall/shared";

import { buildFrameSeries } from "./frame-series";
import { findStutterIndices, medianFrameTimeMs } from "./stutters";

describe("findStutterIndices", () => {
  it("agrees exactly with computeRunSummary on the synthetic fixture", () => {
    const frames = makeSyntheticFrames({ seed: 7, count: 7200 });
    const series = buildFrameSeries(frames);
    const indices = findStutterIndices(series.frameTimes);
    expect(indices.length).toBe(computeRunSummary(frames).stutterCount);
    expect(indices.length).toBe(SYNTHETIC_SPIKE_COUNT);
  });

  it("agrees with computeRunSummary on small even/odd-length captures", () => {
    for (const frameTimes of [
      [10, 10, 10, 50],
      [10, 10, 10, 10, 50],
      [8, 8, 8, 8, 8, 21],
      [8, 8, 8, 8, 8, 19.9],
    ]) {
      let t = 0;
      const frames = frameTimes.map((frameTimeMs) => {
        const frame = { timeMs: t, frameTimeMs };
        t += frameTimeMs;
        return frame;
      });
      expect(findStutterIndices(Float64Array.from(frameTimes)).length).toBe(
        computeRunSummary(frames).stutterCount,
      );
    }
  });

  it("returns the indices of the spiking frames themselves", () => {
    const frameTimes = Float64Array.from([10, 10, 60, 10, 10, 45, 10]);
    expect(Array.from(findStutterIndices(frameTimes))).toEqual([2, 5]);
  });

  it("handles empty input", () => {
    expect(findStutterIndices(new Float64Array(0)).length).toBe(0);
  });
});

describe("medianFrameTimeMs", () => {
  it("uses nearest-rank (matches computeRunSummary's percentile math)", () => {
    expect(medianFrameTimeMs(Float64Array.from([10, 20, 30, 40]))).toBe(20);
    expect(medianFrameTimeMs(Float64Array.from([10, 20, 30]))).toBe(20);
  });

  it("does not mutate its input", () => {
    const input = Float64Array.from([30, 10, 20]);
    medianFrameTimeMs(input);
    expect(Array.from(input)).toEqual([30, 10, 20]);
  });
});
