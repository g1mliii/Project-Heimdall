// @vitest-environment jsdom

/**
 * jsdom smoke coverage for the chart shell: no layout width, no 2D context,
 * no ResizeObserver — the component must still render its DOM without
 * throwing. Pixel/interaction correctness lives in the pure-fn unit tests
 * (downsample/stutters/units) and the Playwright suite, not here.
 */

import * as React from "react";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { makeSyntheticFrames } from "@heimdall/shared";
import { buildFrameSeries } from "@/lib/run/frame-series";
import { findStutterIndices } from "@/lib/run/stutters";
import { FrameTimeChart } from "./FrameTimeChart";

afterEach(cleanup);

describe("FrameTimeChart (jsdom smoke)", () => {
  const series = buildFrameSeries(makeSyntheticFrames({ seed: 7, count: 500 }));
  const stutters = findStutterIndices(series.frameTimes);

  it("renders the canvas and zoom overlay without a layout or 2D context", () => {
    const { container } = render(
      <FrameTimeChart series={series} stutterIndices={stutters} unit="ms" avgFps={120} />,
    );
    expect(
      screen.getByRole("img", { name: "Frame-time progression chart" }),
    ).toBeInTheDocument();
    expect(container.querySelector("[data-chart-overlay]")).toBeInTheDocument();
    // Zero-width container → no plot, so the ready flag must stay pending.
    expect(container.querySelector('[data-chart-state="pending"]')).toBeInTheDocument();
    expect(container.querySelectorAll("[data-axis]").length).toBe(0);
  });

  it("survives a unit switch and an empty series", () => {
    const empty = buildFrameSeries([]);
    const { rerender } = render(
      <FrameTimeChart series={series} stutterIndices={stutters} unit="ms" avgFps={120} />,
    );
    rerender(
      <FrameTimeChart series={series} stutterIndices={stutters} unit="fps" avgFps={120} />,
    );
    rerender(
      <FrameTimeChart series={empty} stutterIndices={new Uint32Array(0)} unit="ms" avgFps={60} />,
    );
  });
});
