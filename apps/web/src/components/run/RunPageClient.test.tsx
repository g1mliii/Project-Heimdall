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
import type { CapabilityManifest, MethodologyManifest, Run } from "@heimdall/shared";
import type { ApiResult } from "@/lib/api/client";
import { buildFrameSeries, type FrameSeries } from "@/lib/run/frame-series";
import { RunPageClient, type FramesLoader } from "./RunPageClient";
import { HAGS_QUALIFICATION } from "./busy-readiness";
import { HardwareCard } from "./HardwareCard";
import { RunHeader } from "./RunHeader";
import { RunStatTiles } from "./RunStatTiles";

vi.mock("./chart/FrameTimeChart", () => ({
  FrameTimeChart: ({
    stutterIndices,
    showBusy,
  }: {
    stutterIndices: Uint32Array;
    showBusy?: boolean;
  }) => (
    <div
      aria-label="Frame-time progression chart"
      data-stutter-count={stutterIndices.length}
      data-show-busy={showBusy ? "true" : "false"}
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

afterEach(() => {
  cleanup();
  window.sessionStorage.clear();
  window.history.replaceState(null, "", "/");
});

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

  it("omits the capability panel for runs without a manifest (§8.6.1)", () => {
    render(<RunPageClient run={run} loadFrames={okLoader} />);
    expect(screen.queryByText("Capture capability")).not.toBeInTheDocument();
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

  it("shows client-signature evidence only when the server actually checked one (§22.3)", () => {
    // A desktop run whose payload matched its signature.
    render(<RunHeader run={{ ...run, signatureValid: true }} />);
    expect(screen.getByText("Client signature checks out")).toBeInTheDocument();
    cleanup();

    // A mismatch is evidence, not a verdict: the run is still Validated beside
    // it, because that comes from the server recompute (§0.5).
    render(<RunHeader run={{ ...run, signatureValid: false }} />);
    expect(screen.getByText("Client signature mismatch")).toBeInTheDocument();
    expect(screen.getByText("Validated")).toBeInTheDocument();
    cleanup();

    // Browser uploads carry no signature at all. Stamping "unsigned" on every
    // one of those would read as a defect rather than the norm it is.
    const unsigned: Run = { ...run };
    delete unsigned.signatureValid;
    render(<RunHeader run={unsigned} />);
    expect(screen.queryByText(/Client signature/)).not.toBeInTheDocument();
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

  it("renders the declared settings string from the methodology manifest (§8.6.2)", () => {
    const manifest: MethodologyManifest = {
      version: 1,
      sceneType: "benchmark-scene",
      settingsPreset: "Ultra",
      graphicsApi: "dx12",
      resolution: "2560x1440",
      upscaler: "dlss",
      rayTracing: "on",
      frameGeneration: "dlss3",
      framePacing: { vsync: false, vrr: true },
      captureDurationSeconds: 62,
    };
    render(<RunHeader run={{ ...run, methodologyManifest: manifest }} />);
    expect(
      screen.getByText(
        `CapFrameX log · Ultra · Ray tracing · 2560x1440 · DX12 · DLSS · ${Math.round(run.summary.durationSeconds)}s capture`,
      ),
    ).toBeInTheDocument();
  });

  it("keeps the capture source when a methodology manifest is present", () => {
    // The capability panel's source badge does NOT cover this: it renders only
    // with a capability manifest, which is a different optional field and only
    // lands canonically once the verify worker runs. Dropping the source from
    // this branch hid it entirely for methodology-declaring pending runs.
    const manifest: MethodologyManifest = {
      version: 1,
      sceneType: "benchmark-scene",
      upscaler: "none",
      rayTracing: "off",
      frameGeneration: "none",
      framePacing: { vsync: false, vrr: false },
    };
    render(
      <RunHeader
        run={{ ...run, methodologyManifest: manifest, capabilityManifest: undefined }}
      />,
    );
    expect(screen.getByText(/^CapFrameX log · /)).toBeInTheDocument();
  });

  it("takes capture length from the canonical summary, never the declared manifest", () => {
    // §11.5: the methodology manifest is uploader-declared and never
    // recomputed, so it must not override the server's recomputed duration.
    const manifest: MethodologyManifest = {
      version: 1,
      sceneType: "benchmark-scene",
      upscaler: "none",
      rayTracing: "off",
      frameGeneration: "none",
      framePacing: { vsync: false, vrr: false },
      captureDurationSeconds: 600,
    };
    render(<RunHeader run={{ ...run, methodologyManifest: manifest }} />);
    expect(
      screen.getByText(new RegExp(`${Math.round(run.summary.durationSeconds)}s capture$`)),
    ).toBeInTheDocument();
    expect(screen.queryByText(/600s capture/)).not.toBeInTheDocument();
  });

  it("renders upscaler and graphics API in brand casing, not raw upper case", () => {
    const manifest: MethodologyManifest = {
      version: 1,
      sceneType: "benchmark-scene",
      graphicsApi: "vulkan",
      upscaler: "xess",
      rayTracing: "off",
      frameGeneration: "none",
      framePacing: { vsync: false, vrr: false },
    };
    render(<RunHeader run={{ ...run, methodologyManifest: manifest }} />);
    // "XESS"/"VULKAN" read as a different brand than the badge map's "XeSS".
    expect(screen.getByText(/Vulkan · XeSS/)).toBeInTheDocument();
  });

  it("skips undeclared settings fields rather than dashing them out (§8.6.2)", () => {
    const sparse: MethodologyManifest = {
      version: 1,
      sceneType: "gameplay",
      upscaler: "unknown",
      rayTracing: "unknown",
      frameGeneration: "none",
      framePacing: { vsync: false, vrr: false },
    };
    render(<RunHeader run={{ ...run, methodologyManifest: sparse }} />);
    // Falls back to the hardware resolution; duration from the summary.
    expect(
      screen.getByText(
        `CapFrameX log · 2560x1440 · ${Math.round(run.summary.durationSeconds)}s capture`,
      ),
    ).toBeInTheDocument();
  });

  it("keeps the pre-8.6 capture-facts subtitle for manifest-less runs", () => {
    render(<RunHeader run={run} />);
    expect(
      screen.getByText(
        `CapFrameX log · 2560x1440 · ${Math.round(run.summary.durationSeconds)}s capture`,
      ),
    ).toBeInTheDocument();
  });

  it("copies the share link and confirms", async () => {
    const writeText = vi.fn(() => Promise.resolve());
    Object.assign(navigator, { clipboard: { writeText } });
    window.history.replaceState(
      null,
      "",
      `/runs/${run.id}?view=chart&claim=query-secret#claim=fragment-secret`,
    );
    render(<RunHeader run={run} />);
    await userEvent.click(screen.getByRole("button", { name: /Share/ }));
    expect(writeText).toHaveBeenCalledWith(
      `${window.location.origin}/runs/${run.id}?view=chart`,
    );
    expect(await screen.findByText("Link copied")).toBeInTheDocument();
  });
});

function busyCapableManifest(overrides: Partial<CapabilityManifest> = {}): CapabilityManifest {
  return {
    version: 1,
    source: "presentmon",
    sensors: {
      gpuLoadPct: { present: true, frameAligned: true },
      gpuClockMhz: { present: true, frameAligned: true },
      gpuPowerW: { present: true, frameAligned: true },
      vramUsedMb: { present: true, frameAligned: true },
      cpuLoadPct: { present: true, frameAligned: true },
      cpuBusyMs: { present: true, frameAligned: true },
      gpuBusyMs: { present: true, frameAligned: true },
    },
    presentationMode: "hardware-independent-flip",
    syncMode: "vrr",
    frameGenerationObserved: true,
    vramCapacity: { totalMb: 12288 },
    caveats: [],
    ...overrides,
  };
}

describe("Busy-time overlay gating (§8.6.8)", () => {
  it("offers the overlay when busy telemetry is frame-aligned, with legend and caption", async () => {
    const loader = vi.fn<FramesLoader>(okLoader);
    render(
      <RunPageClient
        run={{ ...run, capabilityManifest: busyCapableManifest() }}
        loadFrames={loader}
      />,
    );
    await screen.findByRole("img", { name: "Frame-time progression chart" });
    expect(loader).toHaveBeenCalledWith(run.id, expect.anything(), { busyColumns: true });

    const toggle = screen.getByRole("switch", { name: "Busy time" });
    expect(toggle).toBeEnabled();
    expect(screen.queryByText("CPU busy")).not.toBeInTheDocument();

    await userEvent.click(toggle);
    expect(screen.getByText("CPU busy")).toBeInTheDocument();
    expect(screen.getByText("GPU busy")).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "Frame-time progression chart" })).toHaveAttribute(
      "data-show-busy",
      "true",
    );
    expect(screen.getByText(/Gaps mark frames the sensor did not report/)).toBeInTheDocument();
    // No HAGS caveat unless HAGS was declared enabled.
    expect(screen.queryByText(/HAGS-affected/)).not.toBeInTheDocument();
  });

  it("keeps the HAGS qualification on the drawn overlay when declared enabled", async () => {
    const hagsManifest: MethodologyManifest = {
      version: 1,
      sceneType: "benchmark-scene",
      upscaler: "none",
      rayTracing: "off",
      frameGeneration: "none",
      framePacing: { vsync: false, vrr: false },
      hags: "enabled",
    };
    render(
      <RunPageClient
        run={{
          ...run,
          capabilityManifest: busyCapableManifest(),
          methodologyManifest: hagsManifest,
        }}
        loadFrames={okLoader}
      />,
    );
    await screen.findByRole("img", { name: "Frame-time progression chart" });

    await userEvent.click(screen.getByRole("switch", { name: "Busy time" }));
    // The chart caption and the capability panel state ONE qualification
    // sentence: the caption used to hand-write a second, differently-worded
    // copy of it, so this asserts both carry the shared string verbatim.
    const qualified = screen
      .getAllByText((_, element) => element?.textContent?.includes(HAGS_QUALIFICATION.trim()) ?? false)
      .map((element) => element.textContent);
    expect(qualified).toEqual(
      expect.arrayContaining([
        `Gaps mark frames the sensor did not report.${HAGS_QUALIFICATION}`,
      ]),
    );
  });

  it("disables the overlay with the reason when telemetry is not frame-aligned", async () => {
    const manifest = busyCapableManifest();
    manifest.sensors = {
      ...manifest.sensors,
      gpuBusyMs: { present: true, frameAligned: false },
    };
    render(<RunPageClient run={{ ...run, capabilityManifest: manifest }} loadFrames={okLoader} />);
    await screen.findByRole("img", { name: "Frame-time progression chart" });

    expect(screen.getByRole("switch", { name: "Busy time" })).toBeDisabled();
    expect(
      screen.getByText(/periodically sampled, not per-frame — it can't be drawn honestly/),
    ).toBeInTheDocument();
  });

  it("disables the overlay with the reason when busy telemetry is absent", async () => {
    const manifest = busyCapableManifest();
    manifest.sensors = {
      ...manifest.sensors,
      cpuBusyMs: { present: false, frameAligned: false },
      gpuBusyMs: { present: false, frameAligned: false },
    };
    render(<RunPageClient run={{ ...run, capabilityManifest: manifest }} loadFrames={okLoader} />);
    await screen.findByRole("img", { name: "Frame-time progression chart" });

    expect(screen.getByRole("switch", { name: "Busy time" })).toBeDisabled();
    // Both the chart caption and the capability panel name the absence.
    expect(
      screen.getAllByText(/carries no CPU\/GPU busy-time telemetry/).length,
    ).toBeGreaterThan(0);
  });

  it("treats a missing capability manifest as unavailable, never fabricating a trace", async () => {
    render(<RunPageClient run={run} loadFrames={okLoader} />);
    await screen.findByRole("img", { name: "Frame-time progression chart" });

    expect(screen.getByRole("switch", { name: "Busy time" })).toBeDisabled();
    expect(screen.getByText(/Capture capability is unknown for this run/)).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "Frame-time progression chart" })).toHaveAttribute(
      "data-show-busy",
      "false",
    );
  });

  it("disables the switch in FPS mode and names the reason as visible text", async () => {
    render(
      <RunPageClient
        run={{ ...run, capabilityManifest: busyCapableManifest() }}
        loadFrames={okLoader}
      />,
    );
    await screen.findByRole("img", { name: "Frame-time progression chart" });

    await userEvent.click(screen.getByRole("button", { name: "FPS" }));
    expect(screen.getByRole("switch", { name: "Busy time" })).toBeDisabled();
    // The visible label now carries the tooltip too, but the reason must still
    // be on the page for keyboard/touch users, like §8.6.6's count.
    expect(screen.getByText("Busy time is a duration — switch to ms")).toBeVisible();
  });

  it("refuses the overlay when only one busy column decoded", async () => {
    // The legend advertises both traces but the chart draws each only if its
    // column exists, so one-sided data must not read as available.
    const oneSided: FramesLoader = () =>
      Promise.resolve({
        ok: true,
        data: { ...series, cpuBusyMs: new Float64Array(series.count).fill(4), gpuBusyMs: undefined },
      });
    render(
      <RunPageClient
        run={{ ...run, capabilityManifest: busyCapableManifest() }}
        loadFrames={oneSided}
      />,
    );
    await screen.findByRole("img", { name: "Frame-time progression chart" });

    expect(screen.getByRole("switch", { name: "Busy time" })).toBeDisabled();
    expect(screen.getByText(/decoded frames carry no busy-time samples/)).toBeVisible();
    expect(screen.queryByText("GPU busy")).not.toBeInTheDocument();
  });

  it("skips decoding the busy columns when the manifest declares them absent", async () => {
    const absent = busyCapableManifest();
    absent.sensors = {
      ...absent.sensors,
      cpuBusyMs: { present: false, frameAligned: false },
      gpuBusyMs: { present: false, frameAligned: false },
    };
    const loader = vi.fn<FramesLoader>(() => Promise.resolve({ ok: true, data: series }));

    render(<RunPageClient run={{ ...run, capabilityManifest: absent }} loadFrames={loader} />);
    await screen.findByRole("img", { name: "Frame-time progression chart" });

    expect(loader).toHaveBeenCalledWith(run.id, expect.anything(), { busyColumns: false });
  });
});

describe("SmoothnessBars sample count (§8.6.6)", () => {
  it("shows the frame count as visible text, not just a tooltip title", () => {
    render(
      <RunPageClient
        run={{ ...run, summary: { ...run.summary, sampleCount: 12480 } }}
        loadFrames={okLoader}
      />,
    );
    const count = screen.getByText("12,480");
    expect(count).toBeVisible();
    expect(count).toHaveAttribute("data-mono");
    expect(screen.getByText(/for high confidence/)).toBeInTheDocument();
  });
});

describe("HardwareCard (§8.6.5)", () => {
  it("meters peak VRAM against the declared capacity", () => {
    render(
      <HardwareCard
        hardware={{ ...run.hardware, gpuVramTotalMb: 12288 }}
        series={{ ...series, peakVramUsedMb: 11674 }}
      />,
    );
    expect(screen.getByText("11.4 / 12.0 GB")).toBeInTheDocument();
    expect(screen.getByRole("progressbar", { name: "Peak VRAM" })).toBeInTheDocument();
  });

  it("keeps peak VRAM a plain row when no capacity was declared", () => {
    render(<HardwareCard hardware={run.hardware} series={{ ...series, peakVramUsedMb: 11674 }} />);
    // A meter against an unknown max would lie — plain data row only.
    expect(screen.getByText("11.4 GB")).toBeInTheDocument();
    expect(screen.queryByRole("progressbar", { name: "Peak VRAM" })).not.toBeInTheDocument();
  });

  it("meters against the manifest's declared capacity when hardware has none", () => {
    // deriveCapabilityManifest falls back to the declared vramCapacity exactly
    // when gpuVramTotalMb is absent, and verification preserves it — so the
    // capacity IS known here and a bare row would contradict the capability
    // panel printing "12.0 GB" beside it.
    render(
      <HardwareCard
        hardware={{ ...run.hardware, gpuVramTotalMb: undefined }}
        capabilityManifest={busyCapableManifest({ vramCapacity: { totalMb: 12288 } })}
        series={{ ...series, peakVramUsedMb: 11674 }}
      />,
    );
    expect(screen.getByText("11.4 / 12.0 GB")).toBeInTheDocument();
    expect(screen.getByRole("progressbar", { name: "Peak VRAM" })).toBeInTheDocument();
  });

  it("prefers the hardware-owned capacity over a conflicting client manifest", () => {
    render(
      <HardwareCard
        hardware={{ ...run.hardware, gpuVramTotalMb: 8192 }}
        capabilityManifest={busyCapableManifest({ vramCapacity: { totalMb: 12288 } })}
        series={{ ...series, peakVramUsedMb: 7168 }}
      />,
    );
    expect(screen.getByText("7.0 / 8.0 GB")).toBeInTheDocument();
    expect(screen.queryByText("7.0 / 12.0 GB")).not.toBeInTheDocument();
  });

  it("has no GPU vendor row — the GPU string already leads with the vendor", () => {
    render(<HardwareCard hardware={run.hardware} />);
    expect(screen.queryByText("GPU vendor")).not.toBeInTheDocument();
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

  it("renders the run's own P95/P99 frame times and stutter count (§8.6.3)", () => {
    render(
      <RunStatTiles
        summary={{ ...run.summary, frameTimeP95Ms: 9.42, frameTimeP99Ms: 14.18, stutterCount: 12 }}
      />,
    );
    expect(screen.getByText("P95 frame time")).toBeInTheDocument();
    expect(screen.getByText("9.4")).toBeInTheDocument();
    expect(screen.getByText("P99 frame time")).toBeInTheDocument();
    expect(screen.getByText("14.2")).toBeInTheDocument();
    expect(screen.getByText("Stutter events")).toBeInTheDocument();
    expect(screen.getByText("12")).toBeInTheDocument();
  });
});
