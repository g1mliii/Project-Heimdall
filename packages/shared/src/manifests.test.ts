import { describe, expect, it } from "vitest";

import {
  CAPABILITY_MANIFEST_VERSION,
  CAPABILITY_SENSOR_FIELDS,
  METHODOLOGY_MANIFEST_VERSION,
  capabilityManifestSchema,
  methodologyManifestSchema,
} from "./index";
import type { CapabilityManifest, MethodologyManifest } from "./types";

function fullCapabilityManifest(): CapabilityManifest {
  return {
    version: CAPABILITY_MANIFEST_VERSION,
    source: "presentmon",
    sensors: Object.fromEntries(
      CAPABILITY_SENSOR_FIELDS.map((field) => [field, { present: true, frameAligned: true }]),
    ) as CapabilityManifest["sensors"],
    presentationMode: "hardware-independent-flip",
    syncMode: "tearing",
    frameGenerationObserved: true,
    vramCapacity: { totalMb: 12_288 },
    caveats: ["GPU-execution timing is HAGS-affected"],
  };
}

describe("capabilityManifestSchema (§16a.3)", () => {
  it("round-trips a full manifest through parse → serialize → parse", () => {
    const manifest = fullCapabilityManifest();
    const parsed = capabilityManifestSchema.parse(manifest);
    expect(capabilityManifestSchema.parse(JSON.parse(JSON.stringify(parsed)))).toEqual(parsed);
  });

  it("accepts each VRAM-capacity state (§16a.4)", () => {
    for (const vramCapacity of [
      { totalMb: 8192 },
      { state: "unified-memory" as const },
      { state: "unknown" as const },
    ]) {
      expect(
        capabilityManifestSchema.safeParse({ ...fullCapabilityManifest(), vramCapacity }).success,
      ).toBe(true);
    }
  });

  it("defaults the version and stays assignable to the domain type (drift guard)", () => {
    const { version: _omit, ...withoutVersion } = fullCapabilityManifest();
    void _omit;
    const parsed = capabilityManifestSchema.parse(withoutVersion);
    expect(parsed.version).toBe(CAPABILITY_MANIFEST_VERSION);
    const asDomain: CapabilityManifest = parsed;
    const backToSchema: import("./schemas").CapabilityManifestDto = asDomain;
    expect(backToSchema).toEqual(parsed);
  });
});

describe("methodologyManifestSchema (§16c.1)", () => {
  it("round-trips a full manifest", () => {
    const manifest: MethodologyManifest = {
      version: METHODOLOGY_MANIFEST_VERSION,
      gameBuild: "2.1",
      scene: "Dogtown loop",
      sceneType: "benchmark-scene",
      settingsPreset: "Ultra",
      graphicsApi: "dx12",
      resolution: "2560x1440",
      upscaler: "dlss",
      rayTracing: "on",
      frameGeneration: "dlss3",
      framePacing: { capFps: 120, vsync: true, vrr: false, refreshHz: 144 },
      os: "Windows 11",
      gpuDriver: "566.36",
      captureTool: "PresentMon 2.3.0",
      captureProfile: "presentmon-2.x",
      warmupPolicy: "30s discarded",
      captureDurationSeconds: 60,
    };
    const parsed = methodologyManifestSchema.parse(manifest);
    expect(methodologyManifestSchema.parse(JSON.parse(JSON.stringify(parsed)))).toEqual(parsed);
    const asDomain: MethodologyManifest = parsed;
    const backToSchema: import("./schemas").MethodologyManifestDto = asDomain;
    expect(backToSchema).toEqual(parsed);
  });

  it("accepts a minimal declared manifest (only required fields)", () => {
    expect(
      methodologyManifestSchema.safeParse({
        sceneType: "freeform",
        upscaler: "unknown",
        rayTracing: "unknown",
        frameGeneration: "unknown",
        framePacing: { vsync: false, vrr: false },
      }).success,
    ).toBe(true);
  });
});
