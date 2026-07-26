// @vitest-environment jsdom

/**
 * Diagnostic evidence detail (§8.6.4): human-labeled attribution metrics,
 * sensor tags, caveats, and driver provenance render from a populated
 * evidence fixture; raw engine keys never reach the DOM; evidence-less
 * findings render exactly as before; and the label map is drift-guarded
 * against the attribution engine's exported key set.
 */

import * as React from "react";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { DIAGNOSTIC_EVIDENCE_METRIC_KEYS, RUN_STATUS } from "@heimdall/shared";
import type { Diagnostic } from "@heimdall/shared";

import { DiagnosticsCard } from "./DiagnosticsCard";
import { EVIDENCE_METRIC_LABELS } from "./DiagnosticEvidenceDetail";

const attributionFinding: Diagnostic = {
  id: "d1",
  code: "likely-cpu-bound",
  severity: "info",
  title: "Likely CPU-bound",
  detail: "CPU busy time was the critical path on most frames.",
  confidence: "high",
  evidence: {
    coverageFraction: 0.87,
    sensors: ["cpuBusyMs", "gpuBusyMs"],
    metrics: {
      pairedSamples: 10842,
      cpuBoundFraction: 0.62,
      gpuBoundFraction: 0.21,
      cappedFraction: 0.09,
    },
    caveats: ["GPU-execution timing is HAGS-affected and must never be a hard integrity flag."],
  },
};

const driverFinding: Diagnostic = {
  id: "d2",
  code: "gpu-driver-outdated",
  severity: "info",
  title: "Newer GPU driver available",
  detail: "572.16 is the latest game-ready driver for this GPU.",
  evidence: {
    provenance: {
      sourceUrl: "https://example.test/driver-notes",
      referencedVersion: "572.16",
      fetchedAt: "2026-07-12T00:00:00.000Z",
    },
  },
};

const legacyFinding: Diagnostic = {
  id: "d3",
  code: "ram-below-rated",
  severity: "warn",
  title: "RAM is running below its rated speed",
  detail: "Enable its XMP/EXPO profile in the BIOS.",
};

afterEach(cleanup);

describe("DiagnosticEvidenceDetail (§8.6.4)", () => {
  it("renders attribution evidence with human labels, never raw metric keys", () => {
    const { container } = render(
      <DiagnosticsCard diagnostics={[attributionFinding]} status={RUN_STATUS.validated} />,
    );

    expect(screen.getByText("Evidence")).toBeInTheDocument();
    expect(screen.getByText("Paired-frame coverage")).toBeInTheDocument();
    expect(screen.getByText("87%")).toBeInTheDocument();
    expect(screen.getByText("Paired samples")).toBeInTheDocument();
    expect(screen.getByText("10,842")).toBeInTheDocument();
    expect(screen.getByText("CPU-bound frames")).toBeInTheDocument();
    expect(screen.getByText("62%")).toBeInTheDocument();
    expect(screen.getByText("GPU-bound frames")).toBeInTheDocument();
    expect(screen.getByText("21%")).toBeInTheDocument();
    expect(screen.getByText("Cap- or display-limited frames")).toBeInTheDocument();
    expect(screen.getByText("9%")).toBeInTheDocument();
    // Sensors as human-labeled tags; caveats as visible text.
    expect(screen.getByText("CPU busy time")).toBeInTheDocument();
    expect(screen.getByText("GPU busy time")).toBeInTheDocument();
    expect(screen.getByText(/never be a hard integrity flag/)).toBeInTheDocument();
    // Raw engine keys must never leak into the DOM.
    expect(container.textContent).not.toContain("cpuBoundFraction");
    expect(container.textContent).not.toContain("pairedSamples");
  });

  it("renders driver provenance as a source link with version and fetch date", () => {
    render(<DiagnosticsCard diagnostics={[driverFinding]} status={RUN_STATUS.validated} />);

    const source = screen.getByRole("link", { name: "Source" });
    expect(source).toHaveAttribute("href", "https://example.test/driver-notes");
    expect(source).toHaveAttribute("rel", expect.stringContaining("noopener"));
    expect(screen.getByText("572.16")).toBeInTheDocument();
    // The version is named, never a bare figure floating in the provenance line.
    expect(source.closest("p")?.textContent).toContain("Referenced version 572.16");
    expect(screen.getByText(/fetched Jul 12, 2026/)).toBeInTheDocument();
  });

  it("renders evidence-less findings without an Evidence disclosure", () => {
    render(<DiagnosticsCard diagnostics={[legacyFinding]} status={RUN_STATUS.validated} />);
    expect(screen.getByText("RAM is running below its rated speed")).toBeInTheDocument();
    expect(screen.queryByText("Evidence")).not.toBeInTheDocument();
  });

  it("labels every metric key the attribution engine emits (drift guard)", () => {
    expect(Object.keys(EVIDENCE_METRIC_LABELS).sort()).toEqual(
      [...DIAGNOSTIC_EVIDENCE_METRIC_KEYS].sort(),
    );
  });
});
