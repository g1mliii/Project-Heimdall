// @vitest-environment jsdom

/**
 * Run-page component states (§14.1): loading / not-finalized / error /
 * populated, plus share, badges, and the fraction→percent tile. The frames
 * loader is injected, so no network or DB — pixel-level chart correctness
 * lives in the pure-fn unit tests and Playwright, not jsdom.
 */

import * as React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom/vitest";
import { computeRunSummary } from "@heimdall/parsers";
import { makeSyntheticFrames, RUN_STATUS, syntheticRunBase } from "@heimdall/shared";
import type { Run } from "@heimdall/shared";
import type { ApiResult } from "@/lib/api/client";
import { buildFrameSeries, type FrameSeries } from "@/lib/run/frame-series";
import { RunPageClient, type FramesLoader } from "./RunPageClient";
import { RunHeader } from "./RunHeader";
import { RunStatTiles } from "./RunStatTiles";

vi.mock("./chart/FrameTimeChart", () => ({
  FrameTimeChart: ({ stutterIndices }: { stutterIndices: Uint32Array }) => (
    <div
      aria-label="Frame-time progression chart"
      data-stutter-count={stutterIndices.length}
      role="img"
    />
  ),
}));

const frames = makeSyntheticFrames({ seed: 7, count: 1000 });
const run: Run = { ...syntheticRunBase, summary: computeRunSummary(frames) };
const series = buildFrameSeries(frames);

const okLoader: FramesLoader = () => Promise.resolve({ ok: true, data: series });
const failLoader =
  (code: string, message: string): FramesLoader =>
  () =>
    Promise.resolve({ ok: false, code, message });

afterEach(cleanup);

describe("RunPageClient states", () => {
  it("shows a spinner while frames load", () => {
    const never: FramesLoader = () => new Promise<ApiResult<FrameSeries>>(() => {});
    render(<RunPageClient run={run} loadFrames={never} />);
    expect(screen.getByRole("status", { name: "Loading frame data" })).toBeInTheDocument();
  });

  it("aborts an in-flight frames request when the page unmounts", () => {
    let signal: AbortSignal | undefined;
    const pendingLoader: FramesLoader = (_id, nextSignal) => {
      signal = nextSignal;
      return new Promise<ApiResult<FrameSeries>>(() => {});
    };
    const { unmount } = render(<RunPageClient run={run} loadFrames={pendingLoader} />);

    expect(signal?.aborted).toBe(false);
    unmount();
    expect(signal?.aborted).toBe(true);
  });

  it("renders the populated state: frames, GPU meter, peak VRAM", async () => {
    render(<RunPageClient run={run} loadFrames={okLoader} />);
    expect(
      await screen.findByRole("img", { name: "Frame-time progression chart" }),
    ).toBeInTheDocument();
    expect(screen.getByText("Avg GPU load")).toBeInTheDocument();
    expect(screen.getByText("Peak VRAM")).toBeInTheDocument();
    // Summary metrics render regardless of frame state (tile + tier bar).
    expect(screen.getAllByText("Avg FPS").length).toBeGreaterThan(0);
  });

  it("derives pending-run stutter markers from decoded frames, not uploader metadata", async () => {
    const pending: Run = {
      ...run,
      status: RUN_STATUS.pending,
      summary: { ...run.summary, frameTimeP50Ms: 1_000 },
    };
    const pendingFrames = [
      { timeMs: 0, frameTimeMs: 8 },
      { timeMs: 8, frameTimeMs: 8 },
      { timeMs: 16, frameTimeMs: 8 },
      { timeMs: 24, frameTimeMs: 80 },
    ];

    render(
      <RunPageClient
        run={pending}
        loadFrames={() => Promise.resolve({ ok: true, data: buildFrameSeries(pendingFrames) })}
      />,
    );

    expect(
      await screen.findByRole("img", { name: "Frame-time progression chart" }),
    ).toHaveAttribute("data-stutter-count", "1");
  });

  it("shows the still-processing state on not-finalized, tiles intact", async () => {
    render(<RunPageClient run={run} loadFrames={failLoader("not-finalized", "wait")} />);
    expect(await screen.findByText("Frames still processing")).toBeInTheDocument();
    expect(screen.getAllByText("Avg FPS").length).toBeGreaterThan(0);
    expect(screen.queryByText("Avg GPU load")).not.toBeInTheDocument();
  });

  it("shows the error state and retries on demand", async () => {
    let calls = 0;
    const flaky: FramesLoader = () => {
      calls++;
      return calls === 1
        ? Promise.resolve({ ok: false, code: "network", message: "offline" })
        : okLoader("");
    };
    render(<RunPageClient run={run} loadFrames={flaky} />);
    expect(await screen.findByText("Could not load frame data")).toBeInTheDocument();
    expect(screen.getByText("offline")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(
      await screen.findByRole("img", { name: "Frame-time progression chart" }),
    ).toBeInTheDocument();
    expect(calls).toBe(2);
  });

  it("shows a clean diagnostics panel and hardware rows when there are no findings", async () => {
    render(<RunPageClient run={run} loadFrames={okLoader} />);
    expect(screen.getByText("Diagnostics")).toBeInTheDocument();
    expect(screen.getByText("No issues")).toBeInTheDocument();
    expect(screen.getByText("No issues detected")).toBeInTheDocument();
    expect(screen.getByText(run.hardware.gpu)).toBeInTheDocument();
    // RAM below rated speed → warn row with both numbers.
    expect(await screen.findByText("4800 / 6000 MT/s")).toBeInTheDocument();
  });

  it("renders benchmark-set repeatability and excludes the current warm-up pass", () => {
    render(
      <RunPageClient
        run={{ ...run, isWarmup: true }}
        benchmarkSet={{
          warmupRunCount: 1,
          sampleCount: 3,
          meanAvgFps: 101,
          stdDevAvgFps: 0.8,
          coefficientOfVariation: 0.008,
          confidence: "high",
        }}
        loadFrames={okLoader}
      />,
    );

    const benchmarkSetCard = screen.getByLabelText("Benchmark set repeatability");
    expect(benchmarkSetCard).toBeInTheDocument();
    expect(benchmarkSetCard).toHaveTextContent("3 measured runs · 1 warm-up pass excluded");
    expect(screen.getByText("High confidence")).toBeInTheDocument();
    expect(screen.getByText("Mean avg FPS")).toBeInTheDocument();
    expect(screen.getByText("Relative variation (CV)")).toBeInTheDocument();
    for (const numericLabel of ["3", "1"]) {
      for (const numericValue of screen.getAllByText(numericLabel)) {
        expect(numericValue).toHaveAttribute("data-mono");
      }
    }
    expect(screen.getByText("±0.8 FPS")).toHaveAttribute("data-mono");
    expect(screen.getByText(/This run is marked as a warm-up/)).toBeInTheDocument();
  });

  it("does not imply repeatability from one measured pass", () => {
    render(
      <RunPageClient
        run={run}
        benchmarkSet={{
          sampleCount: 1,
          warmupRunCount: 0,
          meanAvgFps: 101,
          stdDevAvgFps: 0,
          coefficientOfVariation: 0,
          confidence: "low",
        }}
        loadFrames={okLoader}
      />,
    );

    expect(screen.getByLabelText("Benchmark set repeatability")).toHaveTextContent(
      "1 measured run · No warm-up passes recorded",
    );
    expect(screen.getByText(/Add another measured run to estimate repeatability/)).toBeInTheDocument();
    expect(screen.queryByText("Relative variation (CV)")).not.toBeInTheDocument();
    expect(screen.queryByText(/Standard deviation/)).not.toBeInTheDocument();
  });

  it("renders real diagnostic findings with severity and a count badge", () => {
    const diagnosticRun: Run = {
      ...run,
      diagnostics: [
        {
          id: "d1",
          code: "vram-saturation-stutter",
          severity: "bad",
          title: "VRAM saturation is causing stutters",
          detail: "Lower texture quality or resolution to free up VRAM headroom.",
        },
        {
          id: "d2",
          code: "ram-below-rated",
          severity: "warn",
          title: "RAM is running below its rated speed",
          detail: "Enable its XMP/EXPO profile in the BIOS.",
        },
      ],
    };
    render(<RunPageClient run={diagnosticRun} loadFrames={okLoader} />);

    expect(screen.getByText("2 issues")).toBeInTheDocument();
    expect(screen.queryByText("No issues detected")).not.toBeInTheDocument();

    const vram = screen.getByText("VRAM saturation is causing stutters");
    expect(vram).toBeInTheDocument();
    expect(screen.getByText("Lower texture quality or resolution to free up VRAM headroom.")).toBeInTheDocument();
    expect(vram.closest(".hd-diag")).toHaveClass("hd-diag--bad");

    const ram = screen.getByText("RAM is running below its rated speed");
    expect(ram.closest(".hd-diag")).toHaveClass("hd-diag--warn");
  });

  it("counts driver advice but not attribution context as an issue", () => {
    const diagnosticRun: Run = {
      ...run,
      diagnostics: [
        {
          id: "d1",
          code: "gpu-driver-outdated",
          severity: "info",
          title: "GPU driver is older than recommended",
          detail: "Install the current driver for the tested game.",
        },
        {
          id: "d2",
          code: "likely-gpu-bound",
          severity: "info",
          title: "Likely GPU-bound",
          detail: "The GPU was the limiting component during this run.",
        },
      ],
    };
    render(<RunPageClient run={diagnosticRun} loadFrames={okLoader} />);

    expect(screen.getByText("1 issue")).toBeInTheDocument();
    expect(screen.queryByText("No issues detected")).not.toBeInTheDocument();
  });

  it("shows a pending diagnostics state (never a false all-clear) before verification", () => {
    const pendingRun: Run = { ...run, status: RUN_STATUS.pending, diagnostics: [] };
    render(<RunPageClient run={pendingRun} loadFrames={okLoader} />);
    expect(screen.getByText("Pending")).toBeInTheDocument();
    expect(screen.getByText("Diagnostics run after verification")).toBeInTheDocument();
    // Must NOT claim the run passed checks that have not run yet.
    expect(screen.queryByText("No issues detected")).not.toBeInTheDocument();
    expect(screen.queryByText("No issues")).not.toBeInTheDocument();
  });
});

describe("RunHeader", () => {
  it("shows validated/tech/visibility badges and disabled stubs", () => {
    render(<RunHeader run={run} />);
    expect(screen.getByText("Validated")).toBeInTheDocument();
    expect(screen.getByText("DLSS 3")).toBeInTheDocument();
    expect(screen.getByText("Public")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Compare/ })).toBeDisabled();
    expect(screen.getByRole("button", { name: /Export video/ })).toBeDisabled();
  });

  it("marks non-validated runs honestly and omits the tech badge for none", () => {
    const pending: Run = { ...run, status: "pending", generatedFrameTech: "none" };
    render(<RunHeader run={pending} />);
    expect(screen.getByText("Pending verification")).toBeInTheDocument();
    expect(screen.queryByText("DLSS 3")).not.toBeInTheDocument();
  });

  it("tells the owner when a run was removed by moderation (§20.5)", () => {
    // Only the owner can ever see a `moderated` run (`isVisibleTo`), so if
    // this renders at all the reader is the one person who needs to know.
    // Without the badge a takedown looked identical to a healthy report while
    // the run had silently dropped out of every public surface.
    const moderated: Run = { ...run, status: "moderated" };
    render(<RunHeader run={moderated} />);
    expect(screen.getByText("Removed by moderation")).toBeInTheDocument();
    expect(screen.getByText(/Only you can see it/)).toBeInTheDocument();
    expect(screen.queryByText("Validated")).not.toBeInTheDocument();
    expect(screen.queryByText("Pending verification")).not.toBeInTheDocument();
  });

  it("distinguishes an integrity-flagged run from a pending one", () => {
    const flagged: Run = { ...run, status: "flagged" };
    render(<RunHeader run={flagged} />);
    expect(screen.getByText("Failed integrity check")).toBeInTheDocument();
    expect(screen.queryByText("Pending verification")).not.toBeInTheDocument();
  });

  it("copies the share link and confirms", async () => {
    const writeText = vi.fn(() => Promise.resolve());
    Object.assign(navigator, { clipboard: { writeText } });
    render(<RunHeader run={run} />);
    await userEvent.click(screen.getByRole("button", { name: /Share/ }));
    expect(writeText).toHaveBeenCalledWith(window.location.href);
    expect(await screen.findByText("Link copied")).toBeInTheDocument();
  });
});

describe("RunStatTiles", () => {
  it("renders generatedFramePct as a whole percent (fraction ×100)", () => {
    render(<RunStatTiles summary={{ ...run.summary, generatedFramePct: 0.4 }} />);
    expect(screen.getByText("Generated frames")).toBeInTheDocument();
    expect(screen.getByText("40")).toBeInTheDocument();
    expect(screen.getByText("%")).toBeInTheDocument();
  });

  it("renders tier values to one decimal", () => {
    render(<RunStatTiles summary={run.summary} />);
    expect(screen.getByText(run.summary.avgFps.toFixed(1))).toBeInTheDocument();
    expect(screen.getByText(run.summary.pointOnePercentLowFps.toFixed(1))).toBeInTheDocument();
  });
});
