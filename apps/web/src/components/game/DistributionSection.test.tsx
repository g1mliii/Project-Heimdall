// @vitest-environment jsdom

import * as React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom/vitest";
import type {
  CohortComparability,
  GameDistributionResponse,
  SearchGameResult,
} from "@heimdall/shared";

import { DistributionSection, type GameDistributionLoader } from "./DistributionSection";

const game: SearchGameResult = { id: "17", slug: "cyberpunk-2077", name: "Cyberpunk 2077" };

function comparability(overrides: Partial<CohortComparability> = {}): CohortComparability {
  return {
    gpu: "GeForce RTX 4070",
    gpuId: "7",
    resolution: "2560x1440",
    scene: "Downtown loop",
    sceneType: "benchmark-scene",
    settingsPreset: "Ultra",
    upscaler: "dlss",
    rayTracing: "on",
    graphicsApi: "dx12",
    frameGeneration: "dlss3",
    frameCapFps: 120,
    vsync: false,
    vrr: true,
    ...overrides,
  };
}

function response(
  cohorts: GameDistributionResponse["cohorts"],
  overrides: Partial<GameDistributionResponse> = {},
): GameDistributionResponse {
  return {
    game,
    metric: "avg-fps",
    betterDirection: "higher",
    cohortDefinitionVersion: 2,
    minSampleSize: 30,
    cohorts,
    truncated: false,
    exclusionSummary: {
      aggregateEligibleRuns: 60,
      pooledObservations: 35,
      unprofiledRuns: 8,
      capabilityUnestablishedRuns: 0,
    },
    diagnosticRates: [
      { key: "driver-currency", label: "Behind on GPU drivers", numerator: 6, denominator: 40, ratePct: 15 },
      { key: "vram-pressure", label: "VRAM-saturation stutter", numerator: 0, denominator: 0, ratePct: null },
      { key: "cpu-bound", label: "CPU-bound", numerator: 8, denominator: 32, ratePct: 25 },
    ],
    ...overrides,
  };
}

const bigCohort: GameDistributionResponse["cohorts"][number] = {
  comparability: comparability(),
  observationCount: 42,
  rawRunCount: 50,
  distribution: {
    bins: [
      { lower: 100, upper: 120, count: 10 },
      { lower: 120, upper: 140, count: 22 },
      { lower: 140, upper: 160, count: 10 },
    ],
    min: 100,
    max: 160,
    mean: 130,
    markers: [
      { p: 1, value: 100 },
      { p: 50, value: 130 },
      { p: 99, value: 160 },
    ],
    sampleCount: 42,
  },
  viewerPercentile: 73,
  viewerValue: 145,
  viewerExclusion: null,
  excludedOutlierCount: 0,
};

afterEach(() => cleanup());

describe("DistributionSection (§17.1–17.5)", () => {
  it("renders the curve, counts, and viewer percentile at/above the threshold", () => {
    const { container } = render(
      <DistributionSection game={game} initial={response([bigCohort])} viewerRunId="run-1" />,
    );

    expect(container.querySelector("[data-chart-state]")).not.toBeNull();
    expect(screen.getByText("42 runs")).toBeInTheDocument();
    expect(screen.getByText("You: 73rd percentile")).toBeInTheDocument();
    // Honest counts: observations weigh sets once, distinct from raw runs.
    expect(screen.getByText(/42 independent observations across 50 runs/)).toBeInTheDocument();
    expect(screen.getByText(/Aggregate · 60 public runs/)).toBeInTheDocument();

    // §17.8 observational rates: a real percent, and "unavailable" when the
    // required telemetry is absent (never a clean 0%).
    expect(screen.getByText("15%")).toBeInTheDocument();
    expect(screen.getByText("unavailable")).toBeInTheDocument();
  });

  it("shows a cold-start explanation and no curve below the threshold", () => {
    const smallCohort = {
      ...bigCohort,
      observationCount: 7,
      rawRunCount: 7,
      distribution: null,
      viewerPercentile: null,
      viewerValue: null,
    };
    const { container } = render(
      <DistributionSection game={game} initial={response([smallCohort])} />,
    );

    expect(screen.getByText("Insufficient data for a distribution")).toBeInTheDocument();
    expect(screen.getByText(/below the 30-run minimum/)).toBeInTheDocument();
    expect(container.querySelector("[data-chart-state]")).toBeNull();
  });

  it("refetches when the metric changes and swaps the curve", async () => {
    const user = userEvent.setup();
    const loader = vi.fn<GameDistributionLoader>().mockResolvedValue({
      ok: true,
      data: response(
        [
          {
            ...bigCohort,
            distribution: { ...bigCohort.distribution!, sampleCount: 42 },
          },
        ],
        { metric: "frametime-p99-ms", betterDirection: "lower" },
      ),
    });
    render(
      <DistributionSection
        game={game}
        initial={response([bigCohort])}
        loadDistribution={loader}
      />,
    );

    await user.selectOptions(screen.getByLabelText("Metric"), "frametime-p99-ms");
    expect(loader).toHaveBeenCalledWith(
      game.slug,
      { metric: "frametime-p99-ms" },
      expect.any(AbortSignal),
    );
  });

  it("qualifies the percentile on a lower-is-better metric", () => {
    render(
      <DistributionSection
        game={game}
        initial={response([bigCohort], { metric: "frametime-p99-ms", betterDirection: "lower" })}
        viewerRunId="run-1"
      />,
    );
    // The server already ranks direction-aware; the badge must say so, or "73rd"
    // reads as "near the bottom" on a metric where low values are the good ones.
    expect(screen.getByText(/You: 73rd percentile \(lower is better\)/)).toBeInTheDocument();
  });

  it("explains a viewer run that is not itself on the curve", () => {
    render(
      <DistributionSection
        game={game}
        initial={response([{ ...bigCohort, viewerExclusion: "statistical-outlier" }])}
        viewerRunId="run-1"
      />,
    );
    expect(screen.getByText(/excluded from this curve as a statistical outlier/)).toBeInTheDocument();
  });

  it("says so when buckets were capped instead of dropping them silently", () => {
    render(
      <DistributionSection game={game} initial={response([bigCohort], { truncated: true })} />,
    );
    expect(
      screen.getByText(/more hardware configurations than one response returns/),
    ).toBeInTheDocument();
  });

  it("keeps exact cohorts separately selectable when only frame pacing differs", async () => {
    const user = userEvent.setup();
    const secondCohort = {
      ...bigCohort,
      comparability: comparability({ frameCapFps: 60, vsync: true, vrr: false }),
      observationCount: 31,
      rawRunCount: 31,
    };
    render(<DistributionSection game={game} initial={response([bigCohort, secondCohort])} />);

    const selector = screen.getByLabelText("Exact cohort");
    expect(selector).toHaveTextContent("120 FPS cap");
    expect(selector).toHaveTextContent("60 FPS cap");

    await user.selectOptions(selector, selector.querySelectorAll("option")[1]!.value);
    expect(selector).toHaveValue(selector.querySelectorAll("option")[1]!.value);
    expect(screen.getByText("31 runs")).toBeInTheDocument();
  });

  it("fetches for itself and offers a retry when the server read failed", async () => {
    const loader = vi.fn<GameDistributionLoader>().mockResolvedValue({
      ok: false,
      code: "server_error",
      message: "distribution unavailable",
    });
    render(<DistributionSection game={game} initial={null} loadDistribution={loader} />);

    // The section must never simply vanish: it loads on its own behalf.
    expect(await screen.findByText("Could not load the distribution")).toBeInTheDocument();
    expect(loader).toHaveBeenCalledTimes(1);

    await userEvent.setup().click(screen.getByRole("button", { name: "Retry" }));
    expect(loader).toHaveBeenCalledTimes(2);
  });

  it("renders a retryable error when the loader rejects", async () => {
    const loader = vi.fn<GameDistributionLoader>().mockRejectedValue(new Error("network interrupted"));
    render(<DistributionSection game={game} initial={null} loadDistribution={loader} />);

    expect(await screen.findByText("Could not load the distribution")).toBeInTheDocument();
    expect(screen.getByText("network interrupted")).toBeInTheDocument();
  });
});
