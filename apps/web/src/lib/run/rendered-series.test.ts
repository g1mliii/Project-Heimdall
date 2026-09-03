/**
 * §22.12 rendered-interval chart series. Two failure modes here are silent —
 * they produce a plausible-looking chart with the wrong x axis — so both are
 * pinned by hand-computed expectations.
 */

import { describe, expect, it } from "vitest";
import { PRESENT_FRAME_TYPE } from "@heimdall/shared";
import { buildFrameSeries } from "./frame-series";
import { buildRenderedSeries } from "./rendered-series";

const { rendered, generated } = PRESENT_FRAME_TYPE;

/** Alternating rendered(8 ms)/generated(0.4 ms) presents on a real time base. */
function alternatingSeries(pairs: number) {
  const frames: { timeMs: number; frameTimeMs: number }[] = [];
  const codes: number[] = [];
  let timeMs = 0;
  for (let i = 0; i < pairs; i++) {
    frames.push({ timeMs, frameTimeMs: 8 });
    codes.push(rendered);
    timeMs += 8;
    frames.push({ timeMs, frameTimeMs: 0.4 });
    codes.push(generated);
    timeMs += 0.4;
  }
  return { series: buildFrameSeries(frames), presentTypes: Uint8Array.from(codes) };
}

describe("buildRenderedSeries", () => {
  it("keeps the REAL time base rather than a synthetic 0, delta, 2delta axis", () => {
    const { series, presentTypes } = alternatingSeries(5);
    const renderedSeries = buildRenderedSeries({ ...series, presentTypes });

    // 5 rendered presents → 4 intervals, each 8.4 ms.
    expect(renderedSeries?.count).toBe(4);
    expect([...renderedSeries!.frameTimes].map((v) => Number(v.toFixed(10)))).toEqual([
      8.4, 8.4, 8.4, 8.4,
    ]);
    // Each interval sits at the timestamp of the rendered present that opened
    // it: rows 0, 2, 4, 6 → 0, 8.4, 16.8, 25.2. A synthetic base would also
    // produce evenly spaced values here, so the assertion that matters is the
    // irregular case below.
    expect([...renderedSeries!.times].map((v) => Number(v.toFixed(10)))).toEqual([
      0, 8.4, 16.8, 25.2,
    ]);
  });

  it("does not compress an unevenly spaced capture", () => {
    // A long pause between two rendered presents must remain visible on the x
    // axis. With a synthetic base every interval would be equally wide and the
    // pause would disappear — the chart would lie about when the run stalled.
    const frames = [
      { timeMs: 0, frameTimeMs: 8 },
      { timeMs: 8, frameTimeMs: 0.4 },
      { timeMs: 8.4, frameTimeMs: 200 },
      { timeMs: 208.4, frameTimeMs: 0.4 },
      { timeMs: 208.8, frameTimeMs: 8 },
    ];
    const presentTypes = Uint8Array.from([rendered, generated, rendered, generated, rendered]);
    const renderedSeries = buildRenderedSeries({
      ...buildFrameSeries(frames),
      presentTypes,
    });

    expect([...renderedSeries!.times].map((v) => Number(v.toFixed(10)))).toEqual([0, 8.4]);
    expect([...renderedSeries!.frameTimes].map((v) => Number(v.toFixed(10)))).toEqual([8.4, 200.4]);
  });

  it("does not mutate the presented series it derives from", () => {
    // `buildFrameSeriesFromColumns` normalizes its `times` argument IN PLACE.
    // Handing it the presented series' own array would corrupt the view the
    // toggle switches back to — a bug that only shows up on the second click.
    const { series, presentTypes } = alternatingSeries(5);
    const presentedTimes = Float64Array.from(series.times);
    const presentedFrameTimes = Float64Array.from(series.frameTimes);

    buildRenderedSeries({ ...series, presentTypes });

    expect([...series.times]).toEqual([...presentedTimes]);
    expect([...series.frameTimes]).toEqual([...presentedFrameTimes]);
  });

  it("returns undefined without a present-type column", () => {
    const { series } = alternatingSeries(5);
    expect(buildRenderedSeries(series)).toBeUndefined();
  });

  it("returns undefined when there are too few rendered presents to form an interval", () => {
    const series = buildFrameSeries([{ timeMs: 0, frameTimeMs: 8 }]);
    expect(buildRenderedSeries({ ...series, presentTypes: Uint8Array.from([rendered]) })).toBeUndefined();
  });
});
