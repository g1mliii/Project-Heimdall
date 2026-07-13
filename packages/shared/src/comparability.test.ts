import { describe, expect, it } from "vitest";

import {
  COMPARABILITY_KEY_FIELD_COUNT,
  comparabilityKey,
  comparabilityKeySql,
  comparabilityMatchSql,
  comparabilityProfileSql,
  type ComparabilityInput,
} from "./comparability";

const base: ComparabilityInput = {
  gameId: "10",
  gpuId: "20",
  resolution: "2560x1440",
  upscaler: "dlss",
  rayTracing: "on",
  frameGeneration: "dlss3",
  graphicsApi: "dx12",
  frameCapFps: 120,
  vsync: true,
  vrr: false,
  sceneType: "benchmark-scene",
};

describe("comparabilityKey (§16c.3)", () => {
  it("is deterministic and identical for identical profiles", () => {
    expect(comparabilityKey(base)).toBe(comparabilityKey({ ...base }));
  });

  it("separates runs whose frame-pacing semantics differ", () => {
    expect(comparabilityKey(base)).not.toBe(comparabilityKey({ ...base, vsync: false }));
    expect(comparabilityKey(base)).not.toBe(comparabilityKey({ ...base, vrr: true }));
    expect(comparabilityKey(base)).not.toBe(comparabilityKey({ ...base, frameCapFps: 60 }));
    expect(comparabilityKey(base)).not.toBe(comparabilityKey({ ...base, frameCapFps: null }));
  });

  it("separates runs whose rendering pipeline differs", () => {
    for (const override of [
      { resolution: "3840x2160" },
      { upscaler: "fsr" as const },
      { rayTracing: "off" as const },
      { frameGeneration: "none" as const },
      { graphicsApi: "vulkan" },
    ]) {
      expect(comparabilityKey(base)).not.toBe(comparabilityKey({ ...base, ...override }));
    }
  });

  it("never pools a benchmark-scene with gameplay or freeform (§17.5)", () => {
    const scene = comparabilityKey({ ...base, sceneType: "benchmark-scene" });
    const gameplay = comparabilityKey({ ...base, sceneType: "gameplay" });
    const freeform = comparabilityKey({ ...base, sceneType: "freeform" });
    expect(new Set([scene, gameplay, freeform]).size).toBe(3);
  });

  it("keeps unresolved game/GPU in their own bucket (sentinel, never empty)", () => {
    const unresolved = comparabilityKey({ ...base, gameId: null, gpuId: null });
    expect(unresolved).toContain("~");
    // Two equally-unresolved runs with the same profile still pool together.
    expect(unresolved).toBe(comparabilityKey({ ...base, gameId: null, gpuId: null }));
  });

  it("aggregate fixtures: only identical profiles share a bucket", () => {
    const runs: Array<{ label: string; input: ComparabilityInput }> = [
      { label: "a1", input: base },
      { label: "a2", input: { ...base } }, // identical → same bucket as a1
      { label: "b", input: { ...base, vsync: false } },
      { label: "c", input: { ...base, resolution: "3840x2160" } },
      { label: "d", input: { ...base, sceneType: "gameplay" } },
    ];
    const buckets = new Map<string, string[]>();
    for (const run of runs) {
      const key = comparabilityKey(run.input);
      buckets.set(key, [...(buckets.get(key) ?? []), run.label]);
    }
    const grouped = [...buckets.values()].map((labels) => labels.sort()).sort();
    expect(grouped).toEqual([["a1", "a2"], ["b"], ["c"], ["d"]]);
  });
});

describe("comparabilityKeySql", () => {
  it("references every comparability column with the caller's alias", () => {
    const sql = comparabilityKeySql("r");
    for (const column of [
      "r.game_id",
      "r.gpu_hardware_id",
      "r.resolution",
      "r.upscaler",
      "r.ray_tracing",
      "r.generated_frame_tech",
      "r.graphics_api",
      "r.frame_pacing_cap",
      "r.vsync",
      "r.vrr",
      "r.scene_type",
    ]) {
      expect(sql).toContain(column);
    }
  });

  it("uses the same field count as the TS builder (drift guard)", () => {
    expect(comparabilityKey(base).split("|")).toHaveLength(COMPARABILITY_KEY_FIELD_COUNT);
  });

  it("renders booleans as true/false to match String(boolean)", () => {
    const sql = comparabilityKeySql();
    expect(sql).toContain("'true'");
    expect(sql).toContain("'false'");
  });
});

describe("comparabilityMatchSql", () => {
  it("uses direct null-safe comparisons for every comparability column", () => {
    const sql = comparabilityMatchSql("r", "base");
    for (const column of [
      "game_id",
      "gpu_hardware_id",
      "resolution",
      "upscaler",
      "ray_tracing",
      "generated_frame_tech",
      "graphics_api",
      "frame_pacing_cap",
      "vsync",
      "vrr",
      "scene_type",
    ]) {
      expect(sql).toContain(`r.${column} is not distinct from base.${column}`);
    }
  });
});

describe("comparabilityProfileSql", () => {
  it("requires a declared methodology profile rather than pooling sentinel values", () => {
    const sql = comparabilityProfileSql("r");
    for (const column of [
      "r.methodology_manifest_version",
      "r.resolution",
      "r.upscaler",
      "r.ray_tracing",
      "r.vsync",
      "r.vrr",
      "r.scene_type",
    ]) {
      expect(sql).toContain(`${column} is not null`);
    }
  });
});
