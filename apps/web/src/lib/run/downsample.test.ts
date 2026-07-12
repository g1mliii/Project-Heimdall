import { describe, expect, it } from "vitest";

import { downsampleMinMax, sliceVisible } from "./downsample";

/** Seeded LCG so property-style sweeps are reproducible. */
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

function syntheticSeries(n: number, seed = 42): { times: Float64Array; values: Float64Array } {
  const rand = lcg(seed);
  const times = new Float64Array(n);
  const values = new Float64Array(n);
  let t = 0;
  for (let i = 0; i < n; i++) {
    const v = 8 + rand() * 2 + (rand() < 0.002 ? 40 + rand() * 30 : 0);
    times[i] = t;
    values[i] = v;
    t += v;
  }
  return { times, values };
}

describe("sliceVisible", () => {
  const times = Float64Array.from([0, 10, 20, 30, 40, 50]);

  it("returns the inclusive index window for a time range", () => {
    expect(sliceVisible(times, 10, 40)).toEqual({ start: 1, end: 5 });
  });

  it("clamps to the array bounds", () => {
    expect(sliceVisible(times, -100, 1000)).toEqual({ start: 0, end: 6 });
  });

  it("returns an empty window for a range between samples", () => {
    expect(sliceVisible(times, 11, 19)).toEqual({ start: 2, end: 2 });
  });
});

describe("downsampleMinMax", () => {
  it("passes raw samples through when the window is small", () => {
    const { times, values } = syntheticSeries(100);
    const out = downsampleMinMax(times, values, 0, 100, 60);
    expect(out.raw).toBe(true);
    expect(Array.from(out.x)).toEqual(Array.from(times));
    expect(Array.from(out.y)).toEqual(Array.from(values));
  });

  it("bounds output to 2×buckets points", () => {
    const { times, values } = syntheticSeries(50_000);
    const out = downsampleMinMax(times, values, 0, 50_000, 800);
    expect(out.raw).toBe(false);
    expect(out.x.length).toBeLessThanOrEqual(1600);
    expect(out.x.length).toBeGreaterThan(800);
  });

  it("keeps output timestamps non-decreasing", () => {
    const { times, values } = syntheticSeries(20_000);
    const out = downsampleMinMax(times, values, 0, 20_000, 500);
    for (let i = 1; i < out.x.length; i++) {
      expect(out.x[i]!).toBeGreaterThanOrEqual(out.x[i - 1]!);
    }
  });

  it("property: the window max and min always survive, for any window/bucket count", () => {
    const { times, values } = syntheticSeries(30_000, 7);
    const rand = lcg(99);
    for (let trial = 0; trial < 50; trial++) {
      const a = Math.floor(rand() * 25_000);
      const b = a + 100 + Math.floor(rand() * (30_000 - a - 100));
      const buckets = 10 + Math.floor(rand() * 990);
      const out = downsampleMinMax(times, values, a, b, buckets);

      let expectedMax = -Infinity;
      let expectedMin = Infinity;
      for (let i = a; i < b; i++) {
        if (values[i]! > expectedMax) expectedMax = values[i]!;
        if (values[i]! < expectedMin) expectedMin = values[i]!;
      }
      let gotMax = -Infinity;
      let gotMin = Infinity;
      for (const v of out.y) {
        if (v > gotMax) gotMax = v;
        if (v < gotMin) gotMin = v;
      }
      expect(gotMax).toBe(expectedMax);
      expect(gotMin).toBe(expectedMin);
    }
  });

  it("handles empty and degenerate windows without throwing", () => {
    const { times, values } = syntheticSeries(100);
    expect(downsampleMinMax(times, values, 50, 50, 100).x.length).toBe(0);
    const timesWithNoSpan = new Float64Array(1000); // all timestamps 0
    const valuesWithSpike = new Float64Array(1000).fill(10);
    valuesWithSpike[120] = 2;
    valuesWithSpike[800] = 60;

    const out = downsampleMinMax(timesWithNoSpan, valuesWithSpike, 0, 1000, 10);
    expect(out.raw).toBe(false);
    expect(Array.from(out.y)).toEqual([2, 60]);
  });
});
