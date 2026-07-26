// @vitest-environment jsdom

/**
 * Capture-capability panel states (§8.6.1): sensor coverage rows, capture
 * semantics, the three bottleneck-readiness statements with the HAGS
 * qualification, VRAM-capacity variants, caveats, and honest absence for
 * manifest-less runs.
 */

import * as React from "react";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import type { CapabilityManifest } from "@heimdall/shared";

import { CapabilityCard } from "./CapabilityCard";

function manifest(overrides: Partial<CapabilityManifest> = {}): CapabilityManifest {
  return {
    version: 1,
    source: "presentmon",
    sensors: {
      gpuLoadPct: { present: true, frameAligned: true },
      gpuClockMhz: { present: true, frameAligned: true },
      gpuPowerW: { present: true, frameAligned: false },
      vramUsedMb: { present: true, frameAligned: true },
      cpuLoadPct: { present: false, frameAligned: false },
      cpuBusyMs: { present: true, frameAligned: true },
      gpuBusyMs: { present: true, frameAligned: true },
    },
    presentationMode: "hardware-independent-flip",
    syncMode: "vrr",
    frameGenerationObserved: true,
    vramCapacity: { totalMb: 12288 },
    caveats: ["GPU-execution timing is HAGS-affected and must never be a hard integrity flag."],
    ...overrides,
  };
}

afterEach(cleanup);

describe("CapabilityCard (§8.6.1)", () => {
  it("renders every sensor with its human label and coverage state", () => {
    render(<CapabilityCard manifest={manifest()} captureSource="presentmon" />);

    for (const label of [
      "GPU load",
      "GPU clock",
      "GPU power",
      "VRAM used",
      "CPU load",
      "CPU busy time",
      "GPU busy time",
    ]) {
      expect(screen.getByText(label)).toBeInTheDocument();
    }
    // Aligned sensors badge good; periodic sensors warn; absent sensors are an
    // honest dash, never a fabricated state.
    expect(screen.getAllByText("Frame-aligned").length).toBe(5);
    expect(screen.getByText("Periodic — not frame-safe")).toBeInTheDocument();
    expect(screen.getByLabelText("Not captured")).toBeInTheDocument();
  });

  it("renders capture semantics, capacity, source, and caveats", () => {
    render(<CapabilityCard manifest={manifest()} captureSource="presentmon" />);
    expect(screen.getByText("PresentMon log")).toBeInTheDocument();
    expect(screen.getByText("Hardware independent flip")).toBeInTheDocument();
    expect(screen.getByText("VRR")).toBeInTheDocument();
    expect(screen.getByText("Observed")).toBeInTheDocument();
    // One rounding rule with the hardware card's meter, which reads "12.0 GB"
    // for this same capacity on the same page.
    expect(screen.getByText("12.0 GB")).toBeInTheDocument();
    expect(screen.getByText(/never be a hard integrity flag/)).toBeInTheDocument();
  });

  it("takes the source badge from the run column, not the client manifest", () => {
    // The manifest is stored verbatim at insert and only overwritten with the
    // server's `captureSource` once the verify worker runs, so an unverified
    // run could otherwise advertise a source its uploader made up.
    render(<CapabilityCard manifest={manifest({ source: "capframex" })} captureSource="mangohud" />);
    expect(screen.getByText("MangoHud log")).toBeInTheDocument();
    expect(screen.queryByText("CapFrameX log")).not.toBeInTheDocument();
  });

  it("keeps coverage badges out of the mono numeric value slot", () => {
    // The kit's SensorRow puts the badge beside the key; SnapshotRow's value
    // span is `data-mono` / --type-data, which is for numerics only.
    const { container } = render(
      <CapabilityCard manifest={manifest()} captureSource="presentmon" />,
    );
    for (const mono of container.querySelectorAll("[data-mono]")) {
      expect(mono.querySelector(".hd-badge")).toBeNull();
    }
  });

  it("renders the unified-memory and unknown VRAM-capacity states", () => {
    const { rerender } = render(
      <CapabilityCard captureSource="presentmon" manifest={manifest({ vramCapacity: { state: "unified-memory" } })} />,
    );
    expect(screen.getByText("Unified memory")).toBeInTheDocument();

    rerender(<CapabilityCard captureSource="presentmon" manifest={manifest({ vramCapacity: { state: "unknown" } })} />);
    expect(screen.getByText("Unknown")).toBeInTheDocument();
  });

  it("declares bottleneck data ready when both busy sensors are frame-aligned", () => {
    render(<CapabilityCard manifest={manifest()} captureSource="presentmon" />);
    expect(screen.getByText("Bottleneck data ready")).toBeInTheDocument();
    expect(screen.getByText(/busy-time overlay are available/)).toBeInTheDocument();
    // No HAGS qualification unless HAGS was declared enabled.
    expect(screen.queryByText(/GPU-bound attribution is approximate/)).not.toBeInTheDocument();
  });

  it("qualifies the ready state when HAGS is declared enabled", () => {
    render(<CapabilityCard manifest={manifest()} captureSource="presentmon" hags="enabled" />);
    expect(screen.getByText(/HAGS-affected, so GPU-bound attribution is approximate/)).toBeInTheDocument();
  });

  it("says periodic busy-time telemetry is not safe for attribution", () => {
    render(
      <CapabilityCard
        captureSource="presentmon"
        manifest={manifest({
          sensors: {
            ...manifest().sensors,
            cpuBusyMs: { present: true, frameAligned: false },
          },
        })}
      />,
    );
    expect(screen.getByText("Bottleneck data not frame-safe")).toBeInTheDocument();
    expect(screen.getByText(/periodically sampled, not per-frame/)).toBeInTheDocument();
  });

  it("blames the source log, not the run, when busy-time telemetry is absent", () => {
    render(
      <CapabilityCard
        captureSource="presentmon"
        manifest={manifest({
          sensors: {
            ...manifest().sensors,
            cpuBusyMs: { present: false, frameAligned: false },
            gpuBusyMs: { present: false, frameAligned: false },
          },
        })}
      />,
    );
    expect(screen.getByText("Bottleneck data absent")).toBeInTheDocument();
    expect(screen.getByText(/limit of the source log, not a fault in the run/)).toBeInTheDocument();
  });

  it("renders nothing at all without a manifest — no placeholder card", () => {
    const { container } = render(<CapabilityCard captureSource="presentmon" />);
    expect(container).toBeEmptyDOMElement();
  });
});
