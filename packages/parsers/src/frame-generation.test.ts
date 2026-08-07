/**
 * §22.12 rendered-frame analysis. The expected numbers here are computed BY
 * HAND in the comments, following the golden-fixture rule: a test that asserts
 * whatever the implementation returned proves only that it is deterministic.
 */

import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { PRESENT_FRAME_TYPE, presentFrameTypeCode } from "@heimdall/shared";
import {
  MIN_RENDERED_INTERVALS,
  coalesceRenderedIntervals,
  computePresentTimeProfile,
  computeRenderedFrameAnalysis,
} from "./frame-generation";
import { computeRunSummaryFromFrameTimes } from "./metrics";

const { rendered, generated, unknown } = PRESENT_FRAME_TYPE;

/** Build a present-type column from a readable pattern. */
function types(...codes: number[]): Uint8Array {
  return Uint8Array.from(codes);
}

/** `n` alternating rendered/generated presents starting rendered. */
function alternating(pairs: number, renderedMs: number, generatedMs: number) {
  const frameTimes: number[] = [];
  const codes: number[] = [];
  for (let i = 0; i < pairs; i++) {
    frameTimes.push(renderedMs, generatedMs);
    codes.push(rendered, generated);
  }
  return { frameTimes, presentTypes: Uint8Array.from(codes) };
}

describe("presentFrameTypeCode", () => {
  it("maps the tri-state without collapsing unknown into rendered", () => {
    expect(presentFrameTypeCode(true)).toBe(generated);
    expect(presentFrameTypeCode(false)).toBe(rendered);
    expect(presentFrameTypeCode(undefined)).toBe(unknown);
  });
});

describe("coalesceRenderedIntervals", () => {
  it("absorbs a generated present into the interval that contains it", () => {
    // Stream: R(8) G(0.4) R(8) G(0.4) R(8)
    // Intervals between consecutive rendered presents (forward convention):
    //   [0]: rows 0..1 = 8 + 0.4 = 8.4
    //   [1]: rows 2..3 = 8 + 0.4 = 8.4
    // Row 4 opens an interval nothing closes → trailing = 8.
    const result = coalesceRenderedIntervals(
      [8, 0.4, 8, 0.4, 8],
      types(rendered, generated, rendered, generated, rendered),
    );

    expect([...result.intervals]).toEqual([8.4, 8.4]);
    expect([...result.startRows]).toEqual([0, 2]);
    expect(result.renderedCount).toBe(3);
    expect(result.generatedCount).toBe(2);
    expect(result.leadingMs).toBe(0);
    expect(result.trailingMs).toBe(8);
  });

  it("yields exactly renderedCount - 1 intervals", () => {
    for (const count of [1, 2, 5, 17]) {
      const { frameTimes, presentTypes } = alternating(count, 8, 0.4);
      const result = coalesceRenderedIntervals(frameTimes, presentTypes);
      expect(result.renderedCount).toBe(count);
      expect(result.intervals.length).toBe(count - 1);
      expect(result.startRows.length).toBe(count - 1);
    }
  });

  it("closes the accounting: sum(intervals) + leading + trailing = sum(frameTimes)", () => {
    // Leading generated presents before any rendered one, and a trailing tail.
    const frameTimes = [0.4, 0.4, 8, 0.4, 8, 0.4, 8, 0.4, 0.4];
    const presentTypes = types(
      generated, generated, rendered, generated, rendered, generated, rendered, generated, generated,
    );
    const result = coalesceRenderedIntervals(frameTimes, presentTypes);

    // leading = 0.4 + 0.4 = 0.8; intervals = [8.4, 8.4]; trailing = 8 + 0.4 + 0.4 = 8.8
    expect(result.leadingMs).toBeCloseTo(0.8, 10);
    expect([...result.intervals].map((v) => Number(v.toFixed(10)))).toEqual([8.4, 8.4]);
    expect(result.trailingMs).toBeCloseTo(8.8, 10);

    const total = frameTimes.reduce((a, b) => a + b, 0);
    const accounted =
      result.intervals.reduce((a, b) => a + b, 0) + result.leadingMs + result.trailingMs;
    expect(accounted).toBeCloseTo(total, 10);
  });

  it("absorbs an unlabelled present rather than treating it as rendered", () => {
    // R(8) ?(2) R(8): the unknown row's time belongs to the interval, and it
    // must NOT open one of its own — we were never told what it was.
    const result = coalesceRenderedIntervals([8, 2, 8], types(rendered, unknown, rendered));
    expect([...result.intervals]).toEqual([10]);
    expect(result.renderedCount).toBe(2);
    expect(result.unknownCount).toBe(1);
    expect(result.generatedCount).toBe(0);
  });

  it("uses the FORWARD convention — the interval starts at the rendered present", () => {
    // Deliberately irregular so the off-by-one is visible: the backward reading
    // would pair row 2's duration with the first interval and produce [50.4],
    // not [8.4].
    const result = coalesceRenderedIntervals(
      [8, 0.4, 50, 0.4],
      types(rendered, generated, rendered, generated),
    );
    expect([...result.intervals]).toEqual([8.4]);
    expect(result.trailingMs).toBeCloseTo(50.4, 10);
  });

  it("rejects mismatched column lengths", () => {
    expect(() => coalesceRenderedIntervals([1, 2, 3], types(rendered, rendered))).toThrow(
      RangeError,
    );
  });
});

describe("computeRenderedFrameAnalysis", () => {
  it("reports the rendered rate on the hand-computed alternating fixture", () => {
    // 12 pairs of R(8 ms) / G(0.4 ms) — 24 presents, 12 × 8.4 = 100.8 ms total.
    //   presented: 1000 × 24 / 100.8 = 238.095238... FPS
    //   rendered:  11 intervals of 8.4 ms = 92.4 ms → 1000 × 11 / 92.4 = 119.047619... FPS
    // Exactly half the presented rate, which is what 1:1 interpolation means.
    //
    // 12 pairs, not the 6 that would make a 12-ROW fixture: 6 rendered presents
    // bound only 5 intervals, which is below MIN_RENDERED_INTERVALS (10) and
    // would correctly return `too-few-rendered-presents` instead of a rate.
    // Both hand-computed rates are unchanged by the larger count.
    const { frameTimes, presentTypes } = alternating(12, 8, 0.4);

    const presented = computeRunSummaryFromFrameTimes(frameTimes, 12);
    expect(presented.avgFps).toBeCloseTo((1000 * 24) / 100.8, 10);
    expect(presented.avgFps).toBeCloseTo(238.095238095, 8);

    const analysis = computeRenderedFrameAnalysis(frameTimes, presentTypes);
    expect(analysis.state).toBe("available");
    if (analysis.state !== "available") return;

    expect(analysis.summary.avgFps).toBeCloseTo((1000 * 11) / 92.4, 10);
    expect(analysis.summary.avgFps).toBeCloseTo(119.047619047, 8);
    // Half the presented rate, to the last bit the floats allow.
    expect(analysis.summary.avgFps).toBeCloseTo(presented.avgFps / 2, 10);
    expect(analysis.summary.sampleCount).toBe(11);
    expect(analysis.summary.frameTimeP50Ms).toBeCloseTo(8.4, 10);
    expect(analysis.renderedCount).toBe(12);
    expect(analysis.generatedCount).toBe(12);
  });

  it("never re-manufactures a generated-frames claim in the rendered summary", () => {
    // Every rendered interval is by construction not generated, so this reads 0
    // — which is why the run page must NOT surface it as "generated frames %".
    const { frameTimes, presentTypes } = alternating(20, 8, 0.4);
    const analysis = computeRenderedFrameAnalysis(frameTimes, presentTypes);
    expect(analysis.state).toBe("available");
    if (analysis.state !== "available") return;
    expect(analysis.summary.generatedFramePct).toBe(0);
    // The honest count survives on the analysis itself.
    expect(analysis.generatedCount).toBe(20);
  });

  it("states no-frame-type-evidence when nothing was ever labelled", () => {
    const analysis = computeRenderedFrameAnalysis(
      [8, 8, 8],
      types(unknown, unknown, unknown),
    );
    expect(analysis).toEqual({ state: "no-frame-type-evidence" });
  });

  it("treats an all-Application capture as NO evidence, not as proof of none", () => {
    // The §22.11 invariant, enforced structurally. A frame-type column full of
    // `Application` is exactly what an uninstrumented driver produces — the
    // project's reference AMD capture had frame generation ON and 14,241 such
    // rows — so it must reach the same state as a capture with no column at
    // all. Splitting these would license "the presented rate is already the
    // rendered rate" for a run that is half interpolated.
    const frameTimes = Array.from({ length: 30 }, () => 8);
    const allApplication = computeRenderedFrameAnalysis(
      frameTimes,
      Uint8Array.from(frameTimes, () => rendered),
    );
    const noColumn = computeRenderedFrameAnalysis(
      frameTimes,
      Uint8Array.from(frameTimes, () => unknown),
    );

    expect(allApplication).toEqual({ state: "no-frame-type-evidence" });
    // Indistinguishable by construction — the whole point.
    expect(allApplication).toEqual(noColumn);
  });

  it("states too-few-rendered-presents below the floor", () => {
    // MIN_RENDERED_INTERVALS intervals need MIN_RENDERED_INTERVALS + 1 rendered
    // presents. One short must not produce a rate.
    const short = alternating(MIN_RENDERED_INTERVALS, 8, 0.4);
    const shortAnalysis = computeRenderedFrameAnalysis(short.frameTimes, short.presentTypes);
    expect(shortAnalysis.state).toBe("too-few-rendered-presents");

    const enough = alternating(MIN_RENDERED_INTERVALS + 1, 8, 0.4);
    const enoughAnalysis = computeRenderedFrameAnalysis(enough.frameTimes, enough.presentTypes);
    expect(enoughAnalysis.state).toBe("available");
  });
});

describe("the naive filter is wrong — the property that proves it", () => {
  it("filtering reproduces the presented rate exactly on a uniform stream", () => {
    // The identity §22.12 warns about, in its cleanest form. When every present
    // carries the same duration d, filtering k of n rows gives
    // `1000·k / (k·d)` = `1000/d`, and the presented rate is `1000·n / (n·d)` =
    // `1000/d`. Dropping rows drops their durations too, so the rate does not
    // move — which is exactly why a rendered summary cannot be a filter.
    const uniform = Array.from({ length: 60 }, () => 4.1);
    const presentTypes = Uint8Array.from(uniform, (_, i) =>
      i % 2 === 0 ? rendered : generated,
    );
    const presented = computeRunSummaryFromFrameTimes(uniform, 30);
    const filtered = uniform.filter((_, i) => presentTypes[i] === rendered);
    const naive = computeRunSummaryFromFrameTimes(filtered, 0);

    expect(naive.avgFps).toBeCloseTo(presented.avgFps, 10);
    expect(naive.avgFps).toBeCloseTo(1000 / 4.1, 10);

    // The coalescer reports the honest rate: 30 rendered presents → 29
    // intervals of 8.2 ms → 1000 × 29 / 237.8 = 121.951... FPS, about half.
    const analysis = computeRenderedFrameAnalysis(uniform, presentTypes);
    expect(analysis.state).toBe("available");
    if (analysis.state !== "available") return;
    expect(analysis.summary.avgFps).toBeCloseTo((1000 * 29) / 237.8, 10);
    expect(analysis.summary.avgFps).toBeCloseTo(presented.avgFps / 2, 8);
  });

  it("filtering is wrong in a THIRD direction when durations differ", () => {
    // With rendered 8 ms and generated 0.4 ms presents, naive filtering lands
    // on neither rate: 50 rendered rows × 8 ms → 1000 × 50 / 400 = 125 FPS,
    // against 238.095 presented and 119.048 genuinely rendered. It is not a
    // conservative approximation — it is a fourth number with no referent.
    const { frameTimes, presentTypes } = alternating(50, 8, 0.4);
    const presented = computeRunSummaryFromFrameTimes(frameTimes, 50);
    const filtered = frameTimes.filter((_, i) => presentTypes[i] === rendered);
    const naive = computeRunSummaryFromFrameTimes(filtered, 0);

    expect(naive.avgFps).toBeCloseTo(125, 10);
    expect(presented.avgFps).toBeCloseTo((1000 * 100) / 420, 10);

    const analysis = computeRenderedFrameAnalysis(frameTimes, presentTypes);
    expect(analysis.state).toBe("available");
    if (analysis.state !== "available") return;
    // 49 intervals of 8.4 ms = 411.6 ms → 1000 × 49 / 411.6 = 119.047619...
    expect(analysis.summary.avgFps).toBeCloseTo((1000 * 49) / 411.6, 10);
    expect(analysis.summary.avgFps).not.toBeCloseTo(naive.avgFps, 1);
  });

  it("an all-rendered stream yields d[0..n-2], NOT the presented summary", () => {
    // Property: this is the second reason an all-rendered stream withholds a
    // rendered summary (the first being §22.11 — no evidence either way). Even
    // setting that aside, the coalesced series is NOT the presented one: it
    // disagrees in the 3rd-4th significant figure, and two numbers claiming to
    // be the same rate and differing slightly is worse than one number.
    fc.assert(
      fc.property(
        fc.array(fc.double({ min: 1, max: 40, noNaN: true }), {
          minLength: MIN_RENDERED_INTERVALS + 2,
          maxLength: 200,
        }),
        (frameTimes) => {
          const presentTypes = Uint8Array.from(frameTimes, () => rendered);
          const { intervals } = coalesceRenderedIntervals(frameTimes, presentTypes);
          // Exactly the input minus its last element.
          expect([...intervals]).toEqual(frameTimes.slice(0, -1));

          const presented = computeRunSummaryFromFrameTimes(frameTimes, 0);
          const coalescedSummary = computeRunSummaryFromFrameTimes(intervals, 0);
          expect(coalescedSummary.sampleCount).toBe(presented.sampleCount - 1);
        },
      ),
    );
  });
});

describe("computePresentTimeProfile (§22.13 characterisation)", () => {
  it("separates a sub-millisecond tail on the scale-free ratio", () => {
    // Shapes modelled on the RX 9070 XT pair's MINIMA (0.32 ms with frame
    // generation on, 3.11 ms with it off), not on its exact distribution — the
    // real capture is not synthesizable here (§22.6), and the measured 12.8 vs
    // 2.46 belongs in docs/frame-generation.md where it is labelled n = 1.
    //
    // FG-on shape: 200 presents, every 4th sub-millisecond.
    //   sorted = 50 × 0.32 then 150 × 7.88; median = nearest rank 100 → 7.88
    //   ratio = 7.88 / 0.32 = 24.625
    const fgOn = computePresentTimeProfile(
      Array.from({ length: 200 }, (_, i) => (i % 4 === 0 ? 0.32 : 7.88)),
    );
    // FG-off shape: one fast frame, the rest steady.
    //   sorted = 3.11 then 199 × 7.65; median = nearest rank 100 → 7.65
    //   ratio = 7.65 / 3.11 = 2.4598...
    const fgOff = computePresentTimeProfile(
      Array.from({ length: 200 }, (_, i) => (i === 0 ? 3.11 : 7.65)),
    );

    expect(fgOn?.minFrameTimeMs).toBeCloseTo(0.32, 10);
    expect(fgOn?.medianOverMinRatio).toBeCloseTo(7.88 / 0.32, 10);
    expect(fgOn?.medianOverMinRatio).toBeCloseTo(24.625, 10);
    expect(fgOn?.subMillisecondPresentFraction).toBeCloseTo(0.25, 10);

    expect(fgOff?.minFrameTimeMs).toBeCloseTo(3.11, 10);
    expect(fgOff?.medianOverMinRatio).toBeCloseTo(7.65 / 3.11, 10);
    expect(fgOff?.subMillisecondPresentFraction).toBe(0);

    // The ratio is scale-free, which is the whole point: it separates the two
    // shapes by an order of magnitude without knowing the base framerate.
    expect(fgOn!.medianOverMinRatio).toBeGreaterThan(fgOff!.medianOverMinRatio * 5);
  });

  it("counts adjacent sub-millisecond pairs only when they cluster", () => {
    // Scattered: no two sub-ms presents adjacent → 0 pairs out of 4.
    const scattered = computePresentTimeProfile([0.4, 8, 0.4, 8, 0.4]);
    expect(scattered?.subMillisecondPresentCount).toBe(3);
    expect(scattered?.adjacentSubMillisecondPairFraction).toBe(0);

    // Clustered: 0.4,0.4,0.4 gives 2 adjacent pairs out of 4.
    const clustered = computePresentTimeProfile([0.4, 0.4, 0.4, 8, 8]);
    expect(clustered?.subMillisecondPresentCount).toBe(3);
    expect(clustered?.adjacentSubMillisecondPairFraction).toBeCloseTo(2 / 4, 10);
  });

  it("returns undefined for an empty stream rather than dividing by zero", () => {
    expect(computePresentTimeProfile([])).toBeUndefined();
  });

  it("reports nearest-rank low-tail percentiles", () => {
    // 10 ascending values 1..10. Nearest rank: ceil(p/100 * 10).
    //   p0.1 → rank 1 → 1;  p1 → rank 1 → 1;  p5 → rank 1 → 1
    // and the median is rank 5 → 5, so the ratio is 5 / 1.
    const profile = computePresentTimeProfile([10, 9, 8, 7, 6, 5, 4, 3, 2, 1]);
    expect(profile?.p0_1Ms).toBe(1);
    expect(profile?.p1Ms).toBe(1);
    expect(profile?.p5Ms).toBe(1);
    expect(profile?.medianOverMinRatio).toBe(5);
  });
});
