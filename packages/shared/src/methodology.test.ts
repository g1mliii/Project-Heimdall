import { describe, expect, it } from "vitest";

import { normalizeMethodologyManifest } from "./methodology";
import type { MethodologyManifest } from "./types";

const manifest: MethodologyManifest = {
  version: 1,
  sceneType: "benchmark-scene",
  resolution: "1920x1080",
  upscaler: "dlss",
  rayTracing: "on",
  frameGeneration: "dlss3",
  framePacing: { vsync: false, vrr: true },
};

describe("normalizeMethodologyManifest", () => {
  it("makes parser-derived resolution and canonical frame generation agree with run columns", () => {
    expect(
      normalizeMethodologyManifest(manifest, { resolution: "2560x1440" }, "none"),
    ).toEqual({
      ...manifest,
      resolution: "2560x1440",
      frameGeneration: "none",
    });
  });

  it("does not manufacture a manifest for a run with no declared methodology", () => {
    expect(normalizeMethodologyManifest(undefined, { resolution: "2560x1440" }, "none")).toBeUndefined();
  });

  it("canonicalizes known graphics API aliases without collapsing unknown APIs", () => {
    expect(
      normalizeMethodologyManifest(
        { ...manifest, graphicsApi: "D3D-12" },
        {},
        "dlss3",
      )?.graphicsApi,
    ).toBe("dx12");
    expect(
      normalizeMethodologyManifest(
        { ...manifest, graphicsApi: "Future API" },
        {},
        "dlss3",
      )?.graphicsApi,
    ).toBe("Future API");
  });
});
