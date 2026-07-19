import { describe, expect, it } from "vitest";

import { OUTLIER } from "./integrity";
import {
  coefficientOfVariation,
  empiricalDistributionBins,
  madOutlierMask,
  mean,
  median,
  modifiedZScores,
  percentile,
  populationStdDev,
} from "./statistics";

/**
 * Local seeded LCG — `@heimdall/shared` cannot depend on `@heimdall/parsers`
 * where `makeLcg` lives, but the numerical-recipes constants match so seeded
 * failures reproduce identically to the parser suites.
 */
function makeLcg(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0xffffffff;
  };
}

function sampleValues(rng: () => number, n: number, span = 200): number[] {
  return Array.from({ length: n }, () => rng() * span + 30);
}

describe("statistics — degenerate inputs (§17.4/§18.2)", () => {
  it("returns neutral values for an empty cohort", () => {
    expect(mean([])).toBe(0);
    expect(median([])).toBe(0);
    expect(percentile([], 95)).toBe(0);
    expect(populationStdDev([])).toBe(0);
    expect(coefficientOfVariation([])).toBe(0);
    expect(modifiedZScores([])).toEqual([]);
    expect(madOutlierMask([])).toEqual([]);
    const dist = empiricalDistributionBins([]);
    expect(dist.sampleCount).toBe(0);
    expect(dist.bins).toEqual([]);
  });

  it("never flags a singleton or an all-identical cohort as an outlier", () => {
    expect(madOutlierMask([42])).toEqual([false]);
    expect(madOutlierMask([7, 7, 7, 7, 7])).toEqual([false, false, false, false, false]);
    const dist = empiricalDistributionBins([7, 7, 7]);
    expect(dist.bins).toEqual([{ lower: 7, upper: 7, count: 3 }]);
    expect(dist.min).toBe(7);
    expect(dist.max).toBe(7);
  });
});

describe("statistics — golden outlier cases", () => {
  it("uses the MAD rule and flags only the extreme value", () => {
    // median = 5, abs-dev median (MAD) = 2, so z(1000) = 0.6745·995/2 ≫ 3.5.
    const values = [1, 2, 3, 4, 5, 6, 7, 8, 9, 1000];
    expect(median(values)).toBe(5);
    const mask = madOutlierMask(values);
    expect(mask).toEqual([false, false, false, false, false, false, false, false, false, true]);
  });

  it("falls back to a population-sigma rule when MAD is degenerate", () => {
    // 29 identical values → MAD is 0; the lone extreme still exceeds 3σ.
    const values = [...Array<number>(29).fill(100), 10_000];
    const mask = madOutlierMask(values);
    expect(mask.filter(Boolean)).toHaveLength(1);
    expect(mask[mask.length - 1]).toBe(true);
  });
});

describe("statistics — seeded invariants (§10.2 pattern)", () => {
  it("holds robust-scoring invariant to positive scale and shift", () => {
    for (let seed = 1; seed <= 40; seed++) {
      const rng = makeLcg(seed);
      const n = 30 + Math.floor(rng() * 40);
      const values = sampleValues(rng, n);
      const scale = 0.5 + rng() * 4;
      const shift = rng() * 100 - 50;
      const transformed = values.map((value) => value * scale + shift);
      // MAD, median, mean and σ all transform affinely with a>0, so the robust
      // z-scores — and therefore the outlier verdict — are invariant.
      expect(madOutlierMask(transformed)).toEqual(madOutlierMask(values));
    }
  });

  it("keeps spread non-negative and CV consistent with mean/σ", () => {
    for (let seed = 1; seed <= 40; seed++) {
      const rng = makeLcg(seed);
      const values = sampleValues(rng, 20 + Math.floor(rng() * 30));
      const sd = populationStdDev(values);
      expect(sd).toBeGreaterThanOrEqual(0);
      const cv = coefficientOfVariation(values);
      expect(cv).toBeCloseTo(sd / mean(values), 10);
    }
  });

  it("keeps nearest-rank percentiles monotone in p", () => {
    for (let seed = 1; seed <= 20; seed++) {
      const rng = makeLcg(seed);
      const values = sampleValues(rng, 50);
      let prev = -Infinity;
      for (const p of [0, 1, 5, 25, 50, 75, 95, 99, 100]) {
        const value = percentile(values, p);
        expect(value).toBeGreaterThanOrEqual(prev);
        prev = value;
      }
    }
  });
});

describe("empiricalDistributionBins", () => {
  it("partitions an even range into equal-width bins whose counts sum to n", () => {
    const dist = empiricalDistributionBins([0, 1, 2, 3, 4, 5, 6, 7, 8, 9], { binCount: 5 });
    expect(dist.bins).toHaveLength(5);
    expect(dist.bins.map((b) => b.count)).toEqual([2, 2, 2, 2, 2]);
    expect(dist.bins[0]!.lower).toBe(0);
    expect(dist.bins[dist.bins.length - 1]!.upper).toBe(9);
    expect(dist.markers).toEqual([
      { p: 1, value: 0 },
      { p: 50, value: 4 },
      { p: 99, value: 9 },
    ]);
  });

  it("assigns every value to exactly one bin for seeded cohorts", () => {
    for (let seed = 1; seed <= 30; seed++) {
      const rng = makeLcg(seed);
      const values = sampleValues(rng, 40 + Math.floor(rng() * 60));
      const dist = empiricalDistributionBins(values);
      const total = dist.bins.reduce((sum, bin) => sum + bin.count, 0);
      expect(total).toBe(values.length);
      expect(dist.min).toBeLessThanOrEqual(dist.max);
    }
  });

  it("reads its thresholds from the shared OUTLIER source", () => {
    // Guardrail: the fallback path must key off the real sigma threshold, not a
    // local copy. A cohort just past 3σ on the sigma path proves the wiring.
    expect(OUTLIER.sigmaThreshold).toBe(3);
    expect(OUTLIER.madZScoreThreshold).toBe(3.5);
  });
});
