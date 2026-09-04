import { describe, expect, it } from "vitest";

import {
  COMPARABILITY_KEY_FIELD_COUNT,
  comparabilityKey,
  comparabilityKeySql,
  comparabilityMatchSql,
  comparabilityProfileSql,
  comparabilitySelectSql,
  type ComparabilityInput,
  buildIdentityRelation,
} from "./comparability";

const base: ComparabilityInput = {
  gameId: "10",
  gpuId: "20",
  resolution: "2560x1440",
  scene: "Dogtown loop",
  settingsPreset: "Ultra",
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
      { scene: "Night City loop" },
      { settingsPreset: "Low" },
      { upscaler: "fsr" as const },
      { rayTracing: "off" as const },
      { frameGeneration: "none" as const },
      { graphicsApi: "vulkan" },
    ]) {
      expect(comparabilityKey(base)).not.toBe(comparabilityKey({ ...base, ...override }));
    }
  });

  it("pools known graphics API aliases but preserves unknown APIs", () => {
    expect(comparabilityKey({ ...base, graphicsApi: "D3D-12" })).toBe(
      comparabilityKey({ ...base, graphicsApi: "dx12" }),
    );
    expect(comparabilityKey({ ...base, graphicsApi: "Future API A" })).not.toBe(
      comparabilityKey({ ...base, graphicsApi: "Future API B" }),
    );
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
      "r.scene",
      "r.settings_preset",
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
      "scene",
      "settings_preset",
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

describe("comparabilitySelectSql", () => {
  it("projects every comparability column with the caller's alias", () => {
    const sql = comparabilitySelectSql("base");
    for (const column of [
      "game_id",
      "gpu_hardware_id",
      "resolution",
      "scene",
      "settings_preset",
      "upscaler",
      "ray_tracing",
      "generated_frame_tech",
      "graphics_api",
      "frame_pacing_cap",
      "vsync",
      "vrr",
      "scene_type",
    ]) {
      expect(sql).toContain(`base.${column}`);
    }
  });
});

describe("comparabilityProfileSql", () => {
  it("requires a declared methodology profile rather than pooling sentinel values", () => {
    const sql = comparabilityProfileSql("r");
    for (const column of [
      "r.methodology_manifest_version",
      "r.resolution",
      "r.scene",
      "r.settings_preset",
      "r.upscaler",
      "r.ray_tracing",
      "r.graphics_api",
      "r.vsync",
      "r.vrr",
      "r.scene_type",
    ]) {
      expect(sql).toContain(`${column} is not null`);
    }
  });
});

describe("buildIdentityRelation (§8.8a)", () => {
  const on = (steamAppId: number, steamBuildId: string) => ({ steamAppId, steamBuildId });

  it("names a real build difference between two runs of one game", () => {
    expect(buildIdentityRelation(on(730, "25000182"), on(730, "25089218"))).toBe("different-build");
  });

  it("recognises two runs on the same build", () => {
    expect(buildIdentityRelation(on(730, "25000182"), on(730, "25000182"))).toBe("same-build");
  });

  it("is unknown when either side never observed a build", () => {
    // A browser upload, a non-Steam title, or a Linux capture (pid 0).
    expect(buildIdentityRelation(on(730, "25000182"), undefined)).toBe("unknown");
    expect(buildIdentityRelation(undefined, on(730, "25000182"))).toBe("unknown");
    expect(buildIdentityRelation(on(730, "25000182"), {})).toBe("unknown");
    expect(buildIdentityRelation(null, null)).toBe("unknown");
  });

  it("does not call two different apps a build difference", () => {
    expect(buildIdentityRelation(on(730, "1"), on(570, "2"))).toBe("unknown");
  });

  it("will not compare build ids that are not anchored to an app", () => {
    // The two fields are independently optional, so a buildid with no appid
    // reaches here. Both sides missing must not read as "the same app": these
    // could be any two titles.
    expect(buildIdentityRelation({ steamBuildId: "1" }, { steamBuildId: "1" })).toBe("unknown");
    expect(buildIdentityRelation({ steamBuildId: "1" }, { steamBuildId: "2" })).toBe("unknown");
    expect(buildIdentityRelation(on(730, "1"), { steamBuildId: "1" })).toBe("unknown");
    expect(buildIdentityRelation({ steamBuildId: "1" }, on(730, "1"))).toBe("unknown");
  });

  it("stays OUT of the pooling key, so a patch cannot shatter a distribution", () => {
    // The whole point: pooling across builds is what lets a distribution exist.
    // If this ever becomes a key field, every game's buckets reset on patch day
    // and fall below the cold-start threshold (§17.4/§18.2).
    expect(Object.keys(base)).not.toContain("steamBuildId");
    expect(Object.keys(base)).not.toContain("steamAppId");
    expect(comparabilityKeySql()).not.toContain("steam_build");
  });
});
