/**
 * Rules-engine tests (§16). Each rule fires on a fixture crafted to trip exactly
 * it; a clean synthetic run trips none (no false positives, §16.2); a
 * sensor-absent input no-ops the sensor-gated rules (§15.5); and a generative
 * pass proves the engine never throws.
 */

import { describe, expect, it } from "vitest";
import {
  makeSyntheticFrames,
  type FrameSample,
  type GpuVendor,
  type HardwareSnapshot,
} from "@heimdall/shared";
import { computeRunSummary } from "../metrics";
import { deriveCapabilityManifest } from "../sensor-availability";
import {
  DIAGNOSTIC_RULES,
  framesToColumns,
  normalizeDriverVersion,
  runDiagnostics,
  type DiagnosticsInput,
} from "./index";

const baseHardware: HardwareSnapshot = {
  gpu: "NVIDIA GeForce RTX 4070",
  cpu: "AMD Ryzen 7 7800X3D",
  gpuVendor: "nvidia",
  ramGb: 32,
  ramSpeedMtps: 6000,
  ramRatedSpeedMtps: 6000,
  gpuDriver: "566.36",
};

function inputFor(
  frames: FrameSample[],
  overrides: Partial<DiagnosticsInput> = {},
): DiagnosticsInput {
  const input: DiagnosticsInput = {
    summary: computeRunSummary(frames),
    hardware: baseHardware,
    source: "capframex",
    vendor: "nvidia",
    driverPlatform: { vendor: "nvidia", os: "windows", component: "gpu" },
    frames: framesToColumns(frames),
    ...overrides,
  };
  // Rich Phase 6.5 attribution requires the same explicit capability evidence
  // that the worker passes after its canonical Parquet recompute. Existing
  // Phase 6 rule fixtures remain agnostic to it.
  return Object.prototype.hasOwnProperty.call(overrides, "capabilityManifest")
    ? input
    : {
        ...input,
        capabilityManifest: deriveCapabilityManifest(frames, input.source, input.hardware),
      };
}

/** Baseline stream at ~10 ms with `stutterMs`-clearing spikes at the given indices. */
function framesWithStutters(
  count: number,
  stutterIndices: number[],
  sensors: (i: number) => Partial<FrameSample> = () => ({}),
): FrameSample[] {
  const spikes = new Set(stutterIndices);
  return Array.from({ length: count }, (_, i) => ({
    timeMs: i * 10,
    frameTimeMs: spikes.has(i) ? 60 : 10,
    ...sensors(i),
  }));
}

describe("runDiagnostics — per-rule fixtures", () => {
  it("fires vram-saturation when stutters land on saturated VRAM", () => {
    const frames = framesWithStutters(30, [7, 14, 21], () => ({ vramUsedMb: 11_900 }));
    const findings = runDiagnostics(
      inputFor(frames, { hardware: { ...baseHardware, gpuVramTotalMb: 12_288 } }),
    );
    const codes = findings.map((f) => f.code);
    expect(codes).toEqual(["vram-saturation-stutter"]);
    const vram = findings.find((f) => f.code === "vram-saturation-stutter")!;
    expect(vram.severity).toBe("bad");
  });

  it("does NOT fire vram-saturation when VRAM has headroom", () => {
    const frames = framesWithStutters(30, [7, 14, 21], () => ({ vramUsedMb: 4_000 }));
    const findings = runDiagnostics(
      inputFor(frames, { hardware: { ...baseHardware, gpuVramTotalMb: 12_288 } }),
    );
    expect(findings.map((f) => f.code)).not.toContain("vram-saturation-stutter");
  });

  it("no-ops vram-saturation when total capacity is unknown", () => {
    const frames = framesWithStutters(30, [7, 14, 21], () => ({ vramUsedMb: 11_900 }));
    const findings = runDiagnostics(inputFor(frames)); // no gpuVramTotalMb
    expect(findings.map((f) => f.code)).not.toContain("vram-saturation-stutter");
  });

  it("fires cpu-bottleneck when the CPU is pegged and the GPU idles", () => {
    const frames = Array.from({ length: 40 }, (_, i) => ({
      timeMs: i * 13,
      // Deliberately not near a common FPS cap: a cap-like cadence must
      // suppress this rule rather than produce a false CPU diagnosis.
      frameTimeMs: 13,
      cpuLoadPct: 98,
      gpuLoadPct: 50,
    }));
    const findings = runDiagnostics(inputFor(frames));
    expect(findings.map((f) => f.code)).toEqual(["cpu-bottleneck"]);
    const cpu = findings.find((f) => f.code === "cpu-bottleneck");
    expect(cpu?.severity).toBe("warn");
  });

  it("does NOT fire cpu-bottleneck for a stable common FPS cap", () => {
    const cappedFrameTimeMs = 1000 / 60;
    const frames = Array.from({ length: 120 }, (_, i) => ({
      timeMs: i * cappedFrameTimeMs,
      frameTimeMs: cappedFrameTimeMs,
      cpuLoadPct: 98,
      gpuLoadPct: 50,
    }));
    expect(runDiagnostics(inputFor(frames)).map((f) => f.code)).not.toContain("cpu-bottleneck");
  });

  it("does NOT fire cpu-bottleneck when the GPU is the limiter", () => {
    const frames = framesWithStutters(40, [], () => ({ cpuLoadPct: 55, gpuLoadPct: 98 }));
    expect(runDiagnostics(inputFor(frames)).map((f) => f.code)).not.toContain("cpu-bottleneck");
  });

  it("no-ops cpu-bottleneck when load sensors are absent", () => {
    const frames = framesWithStutters(40, []); // frameTimeMs only
    expect(runDiagnostics(inputFor(frames)).map((f) => f.code)).not.toContain("cpu-bottleneck");
  });

  it("does NOT diagnose a CPU bottleneck from sparse load telemetry", () => {
    const frames = Array.from({ length: 120 }, (_, i) => ({
      timeMs: i * 13,
      frameTimeMs: 13,
      ...(i === 0 ? { cpuLoadPct: 98, gpuLoadPct: 50 } : {}),
    }));

    expect(runDiagnostics(inputFor(frames)).map((f) => f.code)).not.toContain("cpu-bottleneck");
  });

  it("fires ram-below-rated when configured speed trails rated", () => {
    const frames = framesWithStutters(20, []);
    const findings = runDiagnostics(
      inputFor(frames, { hardware: { ...baseHardware, ramSpeedMtps: 4800, ramRatedSpeedMtps: 6000 } }),
    );
    expect(findings.map((f) => f.code)).toEqual(["ram-below-rated"]);
    const ram = findings.find((f) => f.code === "ram-below-rated");
    expect(ram?.severity).toBe("warn");
    expect(ram?.detail).toContain("4800");
  });

  it("no-ops ram-below-rated within tolerance", () => {
    const frames = framesWithStutters(20, []);
    const findings = runDiagnostics(
      inputFor(frames, { hardware: { ...baseHardware, ramSpeedMtps: 5980, ramRatedSpeedMtps: 6000 } }),
    );
    expect(findings.map((f) => f.code)).not.toContain("ram-below-rated");
  });

  it("fires gpu-driver-outdated against a curated required driver", () => {
    const frames = framesWithStutters(20, []);
    const findings = runDiagnostics(
      inputFor(frames, {
        hardware: { ...baseHardware, gpuDriver: "566.14" },
        game: { requiredDriver: "566.36" },
      }),
    );
    expect(findings.map((f) => f.code)).toEqual(["gpu-driver-outdated"]);
    const driver = findings.find((f) => f.code === "gpu-driver-outdated");
    expect(driver?.severity).toBe("info");
  });

  it("self-suppresses gpu-driver-outdated with no curated value", () => {
    const frames = framesWithStutters(20, []);
    const findings = runDiagnostics(
      inputFor(frames, { hardware: { ...baseHardware, gpuDriver: "500.00" } }),
    );
    expect(findings.map((f) => f.code)).not.toContain("gpu-driver-outdated");
  });

  it("self-suppresses gpu-driver-outdated when the driver is current", () => {
    const frames = framesWithStutters(20, []);
    const findings = runDiagnostics(
      inputFor(frames, {
        hardware: { ...baseHardware, gpuDriver: "570.00" },
        game: { requiredDriver: "566.36" },
      }),
    );
    expect(findings.map((f) => f.code)).not.toContain("gpu-driver-outdated");
  });

  it("self-suppresses gpu-driver-outdated when the requirement platform mismatches", () => {
    const frames = framesWithStutters(20, []);
    for (const vendor of ["amd", "intel"] as const) {
      const findings = runDiagnostics(
        inputFor(frames, {
          vendor,
          hardware: { ...baseHardware, gpuVendor: vendor, gpuDriver: "31.0.24002.92" },
          game: { requiredDriver: "566.36" },
        }),
      );
      expect(findings.map((f) => f.code)).not.toContain("gpu-driver-outdated");
    }
  });

  it("normalizes a current NVIDIA Windows Device Manager driver without a false positive", () => {
    const frames = framesWithStutters(20, []);
    const findings = runDiagnostics(
      inputFor(frames, {
        hardware: { ...baseHardware, gpuDriver: "31.0.15.6636" },
        game: { requiredDriver: "566.36" },
      }),
    );
    expect(findings.map((f) => f.code)).not.toContain("gpu-driver-outdated");
  });

  it("rejects unrelated quad-format strings instead of inventing an NVIDIA version", () => {
    expect(normalizeDriverVersion("1.2.999.1234", "nvidia", "windows", "gpu")).toBeNull();
    expect(normalizeDriverVersion("32.0.16.1074", "nvidia", "windows", "gpu")).toBe(
      "610.74",
    );
  });

  const currencyCells = [
    {
      label: "NVIDIA / Windows",
      vendor: "nvidia",
      os: "windows",
      component: "gpu",
      captured: "609.10",
      latest: "610.74",
    },
    {
      label: "NVIDIA / Linux",
      vendor: "nvidia",
      os: "linux",
      component: "gpu",
      captured: "590.48.01",
      latest: "595.84",
    },
    {
      label: "AMD / Windows",
      vendor: "amd",
      os: "windows",
      component: "gpu",
      captured: "26.5.1",
      latest: "26.6.1",
    },
    {
      label: "Intel / Windows",
      vendor: "intel",
      os: "windows",
      component: "gpu",
      captured: "32.0.101.8800",
      latest: "32.0.101.8861",
    },
    {
      label: "AMD / Linux (Mesa)",
      vendor: "amd",
      os: "linux",
      component: "mesa",
      captured: "Mesa 26.1.3",
      latest: "26.1.4",
    },
    {
      label: "Intel / Linux (Mesa)",
      vendor: "intel",
      os: "linux",
      component: "mesa",
      captured: "Mesa 26.1.3",
      latest: "26.1.4",
    },
  ] as const;

  for (const cell of currencyCells) {
    it(`fires driver-update-available for ${cell.label}`, () => {
      const frames = framesWithStutters(20, []);
      const platform = { vendor: cell.vendor, os: cell.os, component: cell.component };
      const findings = runDiagnostics(
        inputFor(frames, {
          vendor: cell.vendor,
          hardware: {
            ...baseHardware,
            gpuVendor: cell.vendor,
            gpuDriver: cell.captured,
          },
          driverPlatform: platform,
          driverCatalog: { ...platform, latestVersion: cell.latest },
        }),
      );
      expect(findings.map((finding) => finding.code)).toContain("driver-update-available");
    });
  }

  it("self-suppresses driver-update-available without a fresh catalog row", () => {
    const findings = runDiagnostics(
      inputFor(framesWithStutters(20, []), {
        hardware: { ...baseHardware, gpuDriver: "500.00" },
      }),
    );
    expect(findings.map((finding) => finding.code)).not.toContain("driver-update-available");
  });

  it("self-suppresses driver-update-available for a mismatched catalog cell", () => {
    const findings = runDiagnostics(
      inputFor(framesWithStutters(20, []), {
        hardware: { ...baseHardware, gpuDriver: "500.00" },
        driverCatalog: {
          vendor: "nvidia",
          os: "linux",
          component: "gpu",
          latestVersion: "610.74",
        },
      }),
    );
    expect(findings.map((finding) => finding.code)).not.toContain("driver-update-available");
  });
});

describe("runDiagnostics — confidence-graded bottleneck attribution (§16b / 16d.2)", () => {
  /** N frames carrying verified busy times; `sensors(i)` overrides per frame. */
  function busyFrames(count: number, sensors: (i: number) => Partial<FrameSample>): FrameSample[] {
    return Array.from({ length: count }, (_, i) => ({
      timeMs: i * 13,
      frameTimeMs: 13,
      ...sensors(i),
    }));
  }

  it("fires likely-cpu-bound (info, graded) when CPU busy dominates", () => {
    const frames = busyFrames(60, () => ({ cpuBusyMs: 12, gpuBusyMs: 5 }));
    const findings = runDiagnostics(inputFor(frames));
    expect(findings.map((f) => f.code)).toEqual(["likely-cpu-bound"]);
    const cpu = findings[0]!;
    expect(cpu.severity).toBe("info");
    expect(cpu.confidence).toBe("high");
    expect(cpu.ruleVersion).toBe("1.0.0");
    expect(cpu.evidence?.metrics?.cpuBoundFraction).toBeCloseTo(1, 5);
    expect(cpu.evidence?.sensors).toEqual(["cpuBusyMs", "gpuBusyMs"]);
  });

  it("fires likely-gpu-bound when GPU busy dominates", () => {
    const frames = busyFrames(60, () => ({ cpuBusyMs: 5, gpuBusyMs: 12 }));
    expect(runDiagnostics(inputFor(frames)).map((f) => f.code)).toEqual(["likely-gpu-bound"]);
  });

  it("fires frame-capped-or-display-limited at a stable cap above both busy times", () => {
    const capMs = 1000 / 60;
    const frames = Array.from({ length: 60 }, (_, i) => ({
      timeMs: i * capMs,
      frameTimeMs: capMs,
      cpuBusyMs: 8,
      gpuBusyMs: 9,
    }));
    expect(runDiagnostics(inputFor(frames)).map((f) => f.code)).toEqual([
      "frame-capped-or-display-limited",
    ]);
  });

  it("fires telemetry-insufficient when busy telemetry is present but sparse", () => {
    const frames = busyFrames(120, (i) => (i < 10 ? { cpuBusyMs: 12, gpuBusyMs: 5 } : {}));
    const findings = runDiagnostics(inputFor(frames));
    expect(findings.map((f) => f.code)).toEqual(["telemetry-insufficient"]);
    expect(findings[0]!.severity).toBe("info");
  });

  it("keeps HAGS-caveated GPU timing informational, never a hard integrity finding", () => {
    const frames = busyFrames(60, () => ({ cpuBusyMs: 5, gpuBusyMs: 12 }));
    const finding = runDiagnostics(inputFor(frames)).find((item) => item.code === "likely-gpu-bound");
    expect(finding).toMatchObject({ severity: "info", confidence: "high" });
    expect(finding?.evidence?.caveats).toEqual(
      expect.arrayContaining([expect.stringContaining("HAGS")]),
    );
    expect(finding?.severity).not.toBe("bad");
  });

  it("does not treat unified-memory capacity as dedicated-VRAM saturation", () => {
    const frames = framesWithStutters(30, [7, 14, 21], () => ({ vramUsedMb: 11_900 }));
    const capabilityManifest = deriveCapabilityManifest(frames, "capframex", baseHardware);
    capabilityManifest.vramCapacity = { state: "unified-memory" };
    const findings = runDiagnostics(
      inputFor(frames, {
        hardware: { ...baseHardware, gpuVramTotalMb: undefined },
        capabilityManifest,
      }),
    );
    expect(findings.map((finding) => finding.code)).not.toContain("vram-saturation-stutter");
  });

  it("adds NO new finding when the run lacks busy/wait sensors (regression invariant)", () => {
    // frameTimeMs only — no cpuBusyMs/gpuBusyMs columns → every attribution rule
    // is gated out, exactly as Phase 6 behaved.
    const frames = framesWithStutters(60, []);
    const codes = runDiagnostics(inputFor(frames)).map((f) => f.code);
    for (const code of [
      "likely-cpu-bound",
      "likely-gpu-bound",
      "frame-capped-or-display-limited",
      "telemetry-insufficient",
    ]) {
      expect(codes).not.toContain(code);
    }
  });

  it("requires a frame-aligned capability manifest before attributing busy telemetry", () => {
    const frames = busyFrames(60, () => ({ cpuBusyMs: 12, gpuBusyMs: 5 }));

    // A legacy/no-manifest caller retains Phase 6 behavior even if columns
    // happen to be present; the richer likelihood is not guessed.
    expect(
      runDiagnostics(inputFor(frames, { capabilityManifest: undefined })).map((finding) => finding.code),
    ).not.toContain("likely-cpu-bound");

    const manifest = deriveCapabilityManifest(frames, "capframex", baseHardware);
    manifest.sensors.cpuBusyMs.frameAligned = false;
    expect(
      runDiagnostics(inputFor(frames, { capabilityManifest: manifest })).map((finding) => finding.code),
    ).not.toContain("likely-cpu-bound");
  });

  it("stays inconclusive (no attribution) when covered but no regime dominates", () => {
    // ~50/50 cpu/gpu split → no regime reaches the dominant fraction.
    const frames = busyFrames(60, (i) =>
      i % 2 === 0 ? { cpuBusyMs: 12, gpuBusyMs: 5 } : { cpuBusyMs: 5, gpuBusyMs: 12 },
    );
    const codes = runDiagnostics(inputFor(frames)).map((f) => f.code);
    expect(codes).not.toContain("likely-cpu-bound");
    expect(codes).not.toContain("likely-gpu-bound");
    expect(codes).not.toContain("telemetry-insufficient");
  });
});

describe("runDiagnostics — no false positives (§16.2)", () => {
  it("flags no problem on a clean synthetic run — only an informational attribution", () => {
    const frames = makeSyntheticFrames();
    // Full sensors, GPU-bound, healthy RAM, no curated driver, unknown VRAM total.
    const findings = runDiagnostics(inputFor(frames));
    // No warn/bad PROBLEM is raised (the §16.2 invariant)...
    expect(findings.filter((f) => f.severity !== "info")).toEqual([]);
    // ...but the verified busy-time telemetry yields a likelihood-graded read
    // that coexists with the Phase 6 rules (16b): this synthetic run is GPU-bound.
    expect(findings.map((f) => f.code)).toEqual(["likely-gpu-bound"]);
    const gpu = findings.find((f) => f.code === "likely-gpu-bound")!;
    expect(gpu.confidence).toBe("high");
    expect(gpu.ruleVersion).toBe("1.0.0");
    expect(gpu.evidence?.coverageFraction).toBeCloseTo(1, 5);
  });
});

describe("runDiagnostics — totality (§15.5)", () => {
  it("never throws across a generated spread of inputs", () => {
    let seed = 0x1234_5678;
    const rand = () => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed / 4294967296;
    };
    const vendors: GpuVendor[] = ["nvidia", "amd", "intel", "unknown"];
    for (let iter = 0; iter < 200; iter++) {
      const n = 1 + Math.floor(rand() * 40);
      const frames: FrameSample[] = Array.from({ length: n }, (_, i) => {
        const frame: FrameSample = { timeMs: i, frameTimeMs: 0.1 + rand() * 80 };
        if (rand() > 0.5) frame.vramUsedMb = rand() > 0.9 ? NaN : rand() * 16_000;
        if (rand() > 0.5) frame.cpuLoadPct = rand() * 100;
        if (rand() > 0.5) frame.gpuLoadPct = rand() * 100;
        // Busy-time telemetry (incl. NaN/absent gaps) exercises the §16b
        // attribution rules across sparse/misaligned inputs without ever throwing.
        if (rand() > 0.4) frame.cpuBusyMs = rand() > 0.9 ? NaN : rand() * 40;
        if (rand() > 0.4) frame.gpuBusyMs = rand() > 0.9 ? NaN : rand() * 40;
        return frame;
      });
      const input = inputFor(frames, {
        vendor: vendors[Math.floor(rand() * vendors.length)]!,
        hardware: {
          ...baseHardware,
          gpuVramTotalMb: rand() > 0.5 ? rand() * 24_000 : undefined,
          ramSpeedMtps: Math.floor(rand() * 8000),
          ramRatedSpeedMtps: Math.floor(rand() * 8000),
        },
        ...(rand() > 0.5 ? { game: { requiredDriver: `${Math.floor(rand() * 600)}.00` } } : {}),
      });
      const findings = runDiagnostics(input);
      // Beyond totality, every generative result must preserve the public
      // finding contract: exactly one known rule per code with usable copy.
      expect(new Set(findings.map((finding) => finding.code)).size).toBe(findings.length);
      for (const finding of findings) {
        expect(DIAGNOSTIC_RULES.some((rule) => rule.code === finding.code)).toBe(true);
        expect(finding.title.trim()).not.toBe("");
        expect(finding.detail.trim()).not.toBe("");
      }
    }
  });
});
