import { describe, expect, it } from "vitest";
import { CAPABILITY_MANIFEST_VERSION, type FrameSample, type HardwareSnapshot } from "@heimdall/shared";

import {
  SENSOR_AVAILABILITY,
  buildCapabilityManifest,
  deriveCapabilityManifest,
  deriveVramCapacity,
  verifiedCell,
} from "./sensor-availability";
import { parsePresentMon } from "./presentmon";
import { detectPresentMonSemantics } from "./presentmon";
import { readFixture } from "./testing/fixtures";

const hardware: HardwareSnapshot = {
  gpu: "NVIDIA GeForce RTX 4070",
  cpu: "AMD Ryzen 7 7800X3D",
  gpuVendor: "nvidia",
  gpuVramTotalMb: 12_288,
};

describe("deriveVramCapacity (§16a.4)", () => {
  it("distinguishes a known total from 'parser didn't look'", () => {
    expect(deriveVramCapacity(hardware)).toEqual({ totalMb: 12_288 });
    expect(deriveVramCapacity({ ...hardware, gpuVramTotalMb: undefined })).toEqual({ state: "unknown" });
    expect(deriveVramCapacity(undefined)).toEqual({ state: "unknown" });
    expect(deriveVramCapacity({ ...hardware, gpuVramTotalMb: 0 })).toEqual({ state: "unknown" });
  });
});

describe("deriveCapabilityManifest (§16a.3)", () => {
  it("records per-sensor presence and the HAGS caveat when GPU busy is present", () => {
    const frames: FrameSample[] = [
      { timeMs: 0, frameTimeMs: 10, gpuLoadPct: 90, gpuBusyMs: 9 },
      { timeMs: 10, frameTimeMs: 10, gpuLoadPct: 92, gpuBusyMs: 9.1 },
    ];
    const manifest = deriveCapabilityManifest(frames, "capframex", hardware);
    expect(manifest.version).toBe(CAPABILITY_MANIFEST_VERSION);
    expect(manifest.source).toBe("capframex");
    expect(manifest.sensors.gpuLoadPct).toEqual({ present: true, frameAligned: true });
    expect(manifest.sensors.gpuBusyMs).toEqual({ present: true, frameAligned: true });
    expect(manifest.sensors.cpuLoadPct).toEqual({ present: false, frameAligned: false });
    expect(manifest.vramCapacity).toEqual({ totalMb: 12_288 });
    expect(manifest.caveats.some((c) => c.includes("HAGS"))).toBe(true);
  });

  it("has no HAGS caveat and detects frame-generation when present", () => {
    const frames: FrameSample[] = [
      { timeMs: 0, frameTimeMs: 10, cpuLoadPct: 40 },
      { timeMs: 10, frameTimeMs: 10, cpuLoadPct: 42, generated: true },
    ];
    const manifest = deriveCapabilityManifest(frames, "mangohud");
    expect(manifest.caveats).toEqual([]);
    expect(manifest.frameGenerationObserved).toBe(true);
    expect(manifest.vramCapacity).toEqual({ state: "unknown" });
    // Semantics the merged frame stream can't reveal default to unknown.
    expect(manifest.presentationMode).toBe("unknown");
    expect(manifest.syncMode).toBe("unknown");
  });

  it("preserves declared capture semantics through buildCapabilityManifest", () => {
    const manifest = buildCapabilityManifest({
      source: "presentmon",
      presentSensors: ["cpuBusyMs", "gpuBusyMs"],
      frameGenerationObserved: false,
      hardware,
      declared: { presentationMode: "hardware-independent-flip", syncMode: "tearing" },
    });
    expect(manifest.presentationMode).toBe("hardware-independent-flip");
    expect(manifest.syncMode).toBe("tearing");
  });

  it("browser (frames) and worker (presence set) derives agree", () => {
    const frames: FrameSample[] = [
      { timeMs: 0, frameTimeMs: 10, cpuBusyMs: 4, gpuBusyMs: 9 },
      { timeMs: 10, frameTimeMs: 10, cpuBusyMs: 4.1, gpuBusyMs: 9.1 },
    ];
    const fromFrames = deriveCapabilityManifest(frames, "presentmon", hardware);
    const fromPresence = buildCapabilityManifest({
      source: "presentmon",
      presentSensors: ["cpuBusyMs", "gpuBusyMs"],
      frameGenerationObserved: false,
      hardware,
    });
    expect(fromPresence).toEqual(fromFrames);
  });

  it("uses verified matrix evidence when a present sensor is not frame-aligned", () => {
    const original = SENSOR_AVAILABILITY.capframex.nvidia;
    if (original === undefined) throw new Error("expected CapFrameX/NVIDIA matrix cell");

    SENSOR_AVAILABILITY.capframex.nvidia = verifiedCell(
      original.availability,
      {
        source: "capframex",
        gpuVendor: "nvidia",
        driver: "566.36",
        toolVersion: "CapFrameX 1.7.0",
        headers: ["MsGPUActive"],
        units: { gpuBusyMs: "ms" },
        frameAligned: { gpuBusyMs: false },
        fixture: "capframex/csv/nvidia-full-sensors.csv",
      },
    );
    try {
      const manifest = deriveCapabilityManifest(
        [{ timeMs: 0, frameTimeMs: 10, gpuBusyMs: 9 }],
        "capframex",
        hardware,
      );
      expect(manifest.sensors.gpuBusyMs).toEqual({ present: true, frameAligned: false });
    } finally {
      SENSOR_AVAILABILITY.capframex.nvidia = original;
    }
  });
});

describe("detectPresentMonSemantics (§16a.2)", () => {
  it("detects presentation/sync semantics from the pinned v2 fixture headers", () => {
    // v2-basic carries PresentMode="Hardware: Independent Flip", AllowsTearing=1.
    const result = parsePresentMon(readFixture("presentmon/v2-basic.csv"));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.captureSemantics).toEqual({
        graphicsApi: "dxgi",
        presentationMode: "hardware-independent-flip",
        syncMode: "tearing",
      });
      expect(result.value.captureProfile).toBe("presentmon-2.x");
    }
  });

  it("detects v1 runtime semantics and records its pinned profile", () => {
    const result = parsePresentMon(readFixture("presentmon/v1-basic.csv"));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.captureSemantics).toMatchObject({ graphicsApi: "dxgi" });
      expect(result.value.captureProfile).toBe("presentmon-1.x");
    }
  });

  it("maps PresentMode + tearing/sync cells to canonical semantics", () => {
    const csv = [
      "Application,FrameTime,PresentMode,AllowsTearing,SyncInterval",
      "game.exe,8.3,Hardware: Independent Flip,1,0",
      "game.exe,8.4,Hardware: Independent Flip,1,0",
    ].join("\n");
    const result = parsePresentMon(csv);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.captureSemantics).toEqual({
        presentationMode: "hardware-independent-flip",
        syncMode: "tearing",
      });
    }
  });

  it("reads vsync from a non-zero SyncInterval when tearing is disallowed", () => {
    const csv = [
      "Application,FrameTime,PresentMode,AllowsTearing,SyncInterval",
      "game.exe,8.3,Composed: Flip,0,1",
    ].join("\n");
    const result = parsePresentMon(csv);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.captureSemantics?.presentationMode).toBe("composed");
      expect(result.value.captureSemantics?.syncMode).toBe("vsync");
    }
  });

  void detectPresentMonSemantics;
});
