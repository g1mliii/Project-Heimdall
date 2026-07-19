import { describe, expect, it } from "vitest";
import { runSummarySchema, STUTTER, type FrameSample, type RunSummary } from "@heimdall/shared";

import {
  computeBenchmarkSetStats,
  computeRunSummary,
  computeRunSummaryFromFrameTimes,
  computeSetRepresentative,
} from "./metrics";
import { makeLcg } from "./testing/rng";

/** Bare frames from a frame-time list, timestamped by cumulative sum. */
function frames(frameTimesMs: readonly number[]): FrameSample[] {
  let t = 0;
  return frameTimesMs.map((frameTimeMs) => {
    const frame = { timeMs: t, frameTimeMs };
    t += frameTimeMs;
    return frame;
  });
}

describe("computeRunSummary — hand-computed cases (§9.1)", () => {
  it("computes every field for a 4-frame capture", () => {
    const summary = computeRunSummary(frames([10, 20, 30, 40]));
    expect(summary).toEqual({
      avgFps: 40, // 1000 * 4 / 100
      onePercentLowFps: 25, // slowest ceil(0.04)=1 frame → 40ms
      pointOnePercentLowFps: 25,
      frameTimeP50Ms: 20, // sorted[ceil(2)-1]
      frameTimeP95Ms: 40, // sorted[ceil(3.8)-1]
      frameTimeP99Ms: 40,
      stutterCount: 0, // 40 ≤ 2.5 × 20
      generatedFramePct: 0,
      pointOnePercentLowConfidence: "low",
      sampleCount: 4,
      durationSeconds: 0.1,
    });
  });

  it("degrades sanely to a single frame", () => {
    const summary = computeRunSummary(frames([16]));
    expect(summary.avgFps).toBeCloseTo(62.5, 9);
    expect(summary.onePercentLowFps).toBeCloseTo(62.5, 9);
    expect(summary.pointOnePercentLowFps).toBeCloseTo(62.5, 9);
    expect(summary.frameTimeP50Ms).toBe(16);
    expect(summary.frameTimeP99Ms).toBe(16);
    expect(summary.stutterCount).toBe(0);
  });

  it("averages the slowest 1% as FPS, not as frame time", () => {
    // 200 frames: 198 × 10ms + 30ms + 50ms → 1% low = mean(30, 50) = 40ms → 25 FPS.
    const summary = computeRunSummary(frames([...Array.from({ length: 198 }, () => 10), 30, 50]));
    expect(summary.onePercentLowFps).toBe(25);
    expect(summary.pointOnePercentLowFps).toBe(20); // slowest 1 frame → 50ms
  });

  it("counts generated frames as a 0–1 fraction", () => {
    const mixed = frames([10, 10, 10, 10]).map((f, i) => ({ ...f, generated: i === 0 }));
    expect(computeRunSummary(mixed).generatedFramePct).toBe(0.25);
  });

  it("throws RangeError on an empty array (parsers can never produce one)", () => {
    expect(() => computeRunSummary([])).toThrow(RangeError);
  });
});

describe("stutter edges (§9.1)", () => {
  it("requires BOTH the median multiple and the absolute floor", () => {
    // Median 8ms → multiplier bound 20ms; the floor is also 20ms. A 20ms frame
    // (equal, not greater) is not a stutter; 20.5ms is.
    const base = Array.from({ length: 19 }, () => 8);
    expect(computeRunSummary(frames([...base, 20])).stutterCount).toBe(0);
    expect(computeRunSummary(frames([...base, 20.5])).stutterCount).toBe(1);
  });

  it("does not flag slow-but-steady captures via the floor alone", () => {
    // Median 40ms → multiplier bound 100ms. 90ms exceeds the 20ms floor but
    // not 2.5× median, so a uniformly slow capture reports no stutter.
    const base = Array.from({ length: 19 }, () => 40);
    expect(computeRunSummary(frames([...base, 90])).stutterCount).toBe(0);
    expect(computeRunSummary(frames([...base, 101])).stutterCount).toBe(1);
  });

  it("uses the shared STUTTER constant", () => {
    expect(STUTTER.medianMultiplier).toBe(2.5);
    expect(STUTTER.minFrameTimeMs).toBe(20);
  });
});

describe("0.1%-low confidence boundaries (§9.2)", () => {
  const confidenceAt = (n: number) =>
    computeRunSummary(frames(Array.from({ length: n }, () => 10))).pointOnePercentLowConfidence;

  it("grades n=999 low, n=1000 medium, n=4999 medium, n=5000 high", () => {
    expect(confidenceAt(999)).toBe("low");
    expect(confidenceAt(1000)).toBe("medium");
    expect(confidenceAt(4999)).toBe("medium");
    expect(confidenceAt(5000)).toBe("high");
  });
});

describe("generative invariants (seeded LCG, §10.2)", () => {
  it("holds the §9 invariants over 200 random frame streams", () => {
    const rand = makeLcg(0x9e3779b1);

    for (let iteration = 0; iteration < 200; iteration++) {
      const n = 1 + Math.floor(rand() * 300);
      const stream: FrameSample[] = frames(
        Array.from({ length: n }, () => 0.1 + rand() * 99.9),
      ).map((f) => (rand() < 0.1 ? { ...f, generated: rand() < 0.5 } : f));

      const summary = computeRunSummary(stream);

      for (const [key, value] of Object.entries(summary)) {
        if (typeof value === "number") {
          expect(Number.isFinite(value), `${key} finite (iteration ${iteration})`).toBe(true);
        }
      }
      expect(summary.avgFps).toBeGreaterThan(0);
      expect(summary.onePercentLowFps).toBeGreaterThan(0);
      expect(summary.pointOnePercentLowFps).toBeLessThanOrEqual(summary.onePercentLowFps + 1e-9);
      expect(summary.frameTimeP50Ms).toBeLessThanOrEqual(summary.frameTimeP95Ms);
      expect(summary.frameTimeP95Ms).toBeLessThanOrEqual(summary.frameTimeP99Ms);
      expect(summary.generatedFramePct).toBeGreaterThanOrEqual(0);
      expect(summary.generatedFramePct).toBeLessThanOrEqual(1);
      expect(summary.stutterCount).toBeGreaterThanOrEqual(0);
      expect(summary.stutterCount).toBeLessThanOrEqual(n);
      expect(summary.sampleCount).toBe(n);
      expect(runSummarySchema.safeParse(summary).success).toBe(true);
    }
  });

  it("keeps the scalar-buffer implementation bit-identical to the frame-object oracle", () => {
    const rand = makeLcg(0x85ebca6b);

    for (let iteration = 0; iteration < 200; iteration++) {
      const n = 1 + Math.floor(rand() * 300);
      const stream: FrameSample[] = frames(
        Array.from({ length: n }, () => 0.1 + rand() * 99.9),
      ).map((frame) => (rand() < 0.1 ? { ...frame, generated: rand() < 0.5 } : frame));
      const generatedFrameCount = stream.filter((frame) => frame.generated === true).length;

      expect(
        computeRunSummaryFromFrameTimes(
          Float64Array.from(stream, (frame) => frame.frameTimeMs),
          generatedFrameCount,
        ),
      ).toEqual(computeRunSummary(stream));
    }
  });
});

describe("computeBenchmarkSetStats (§16c.2)", () => {
  const summaryWith = (avgFps: number): RunSummary => ({
    avgFps,
    onePercentLowFps: avgFps * 0.8,
    pointOnePercentLowFps: avgFps * 0.7,
    frameTimeP50Ms: 1000 / avgFps,
    frameTimeP95Ms: 1000 / (avgFps * 0.8),
    frameTimeP99Ms: 1000 / (avgFps * 0.7),
    stutterCount: 0,
    generatedFramePct: 0,
    pointOnePercentLowConfidence: "high",
    sampleCount: 5000,
    durationSeconds: 60,
  });
  const member = (avgFps: number, isWarmup = false) => ({ summary: summaryWith(avgFps), isWarmup });

  it("excludes warm-up runs and reports the spread", () => {
    const stats = computeBenchmarkSetStats([
      member(200, true), // warm-up — ignored
      member(100),
      member(102),
      member(101),
    ]);
    expect(stats.sampleCount).toBe(3);
    expect(stats.warmupRunCount).toBe(1);
    expect(stats.meanAvgFps).toBeCloseTo(101, 5);
    expect(stats.coefficientOfVariation).toBeLessThan(0.03);
    expect(stats.confidence).toBe("high");
  });

  it("grades a wide spread as low confidence", () => {
    const stats = computeBenchmarkSetStats([member(80), member(120), member(100)]);
    expect(stats.sampleCount).toBe(3);
    expect(stats.coefficientOfVariation).toBeGreaterThan(0.08);
    expect(stats.confidence).toBe("low");
  });

  it("never promotes a lone run and returns zeroed stats for an all-warm-up set", () => {
    expect(computeBenchmarkSetStats([member(100)]).confidence).toBe("low");
    const empty = computeBenchmarkSetStats([member(100, true), member(101, true)]);
    expect(empty.sampleCount).toBe(0);
    expect(empty.warmupRunCount).toBe(2);
    expect(empty.meanAvgFps).toBe(0);
  });

  it("never lets arbitrary warm-up values affect a measured set (seeded property)", () => {
    const rand = makeLcg(0x27d4eb2d);

    for (let iteration = 0; iteration < 200; iteration++) {
      const measured = Array.from({ length: 1 + Math.floor(rand() * 12) }, () =>
        member(30 + rand() * 270),
      );
      const warmups = Array.from({ length: Math.floor(rand() * 8) }, () =>
        member(1 + rand() * 999, true),
      );

      const withWarmups = computeBenchmarkSetStats([...warmups, ...measured]);
      expect({ ...withWarmups, warmupRunCount: 0 }).toEqual(computeBenchmarkSetStats(measured));
      expect(withWarmups.warmupRunCount).toBe(warmups.length);
    }
  });

  describe("computeSetRepresentative (§17.0.2)", () => {
    it("returns the nearest-rank median member and ignores warm-ups", () => {
      // Three passes → the middle avg FPS represents the set (one observation).
      expect(computeSetRepresentative([member(200, true), member(100), member(102), member(101)])).toBe(
        101,
      );
    });

    it("weighs 30 duplicate uploads as a single observation", () => {
      const duplicates = Array.from({ length: 30 }, () => member(144));
      expect(computeSetRepresentative(duplicates)).toBe(144);
    });

    it("has no representative for an all-warm-up set", () => {
      expect(computeSetRepresentative([member(100, true), member(101, true)])).toBeNull();
      expect(computeSetRepresentative([])).toBeNull();
    });
  });
});
