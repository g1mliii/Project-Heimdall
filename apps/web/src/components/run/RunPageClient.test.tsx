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
import { makeSyntheticFrames, syntheticRunBase } from "@heimdall/shared";
import type { Run } from "@heimdall/shared";
import type { ApiResult } from "@/lib/api/client";
import type { FrameSample } from "@heimdall/shared";
import { RunPageClient, type FramesLoader } from "./RunPageClient";
import { RunHeader } from "./RunHeader";
import { RunStatTiles } from "./RunStatTiles";

const frames = makeSyntheticFrames({ seed: 7, count: 1000 });
const run: Run = { ...syntheticRunBase, summary: computeRunSummary(frames) };

const okLoader: FramesLoader = () => Promise.resolve({ ok: true, data: frames });
const failLoader =
  (code: string, message: string): FramesLoader =>
  () =>
    Promise.resolve({ ok: false, code, message });

afterEach(cleanup);

describe("RunPageClient states", () => {
  it("shows a spinner while frames load", () => {
    const never: FramesLoader = () => new Promise<ApiResult<FrameSample[]>>(() => {});
    render(<RunPageClient run={run} loadFrames={never} />);
    expect(screen.getByRole("status", { name: "Loading frame data" })).toBeInTheDocument();
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

  it("keeps the diagnostics stub and hardware rows in every state", async () => {
    render(<RunPageClient run={run} loadFrames={okLoader} />);
    expect(screen.getByText("Diagnostics")).toBeInTheDocument();
    expect(screen.getByText("Coming soon")).toBeInTheDocument();
    expect(screen.getByText(run.hardware.gpu)).toBeInTheDocument();
    // RAM below rated speed → warn row with both numbers.
    expect(await screen.findByText("4800 / 6000 MT/s")).toBeInTheDocument();
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
