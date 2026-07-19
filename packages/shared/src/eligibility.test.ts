import { describe, expect, it } from "vitest";

import { CAPABILITY_MANIFEST_VERSION, METHODOLOGY_MANIFEST_VERSION } from "./constants";
import {
  COHORT_DEFINITION_VERSION,
  COHORT_EXCLUSION,
  cohortEligibilitySql,
  cohortExclusionReasons,
  cohortObservationsSql,
  type CohortEligibilityInput,
} from "./eligibility";
import type { MethodologyManifest } from "./types";

const completeMethodology: MethodologyManifest = {
  version: METHODOLOGY_MANIFEST_VERSION,
  scene: "Dogtown loop",
  sceneType: "benchmark-scene",
  settingsPreset: "Ultra",
  graphicsApi: "dx12",
  resolution: "2560x1440",
  upscaler: "dlss",
  rayTracing: "on",
  frameGeneration: "dlss3",
  framePacing: { capFps: 120, vsync: false, vrr: true },
};

const eligible: CohortEligibilityInput = {
  visibility: "public",
  status: "validated",
  gameId: "10",
  gpuId: "20",
  methodologyManifest: completeMethodology,
  methodologyManifestVersion: METHODOLOGY_MANIFEST_VERSION,
  capabilityManifestVersion: CAPABILITY_MANIFEST_VERSION,
  isWarmup: false,
  benchmarkSetId: null,
};

describe("cohortExclusionReasons (§16e.4)", () => {
  it("keeps cohort readiness distinct from lifecycle status", () => {
    expect(cohortExclusionReasons(eligible)).toEqual([]);
    expect(
      cohortExclusionReasons({
        ...eligible,
        methodologyManifest: undefined,
        methodologyManifestVersion: null,
      }),
    ).toEqual([COHORT_EXCLUSION.unprofiled]);
  });

  it.each([
    [COHORT_EXCLUSION.notPublic, { visibility: "unlisted" as const }],
    [COHORT_EXCLUSION.notValidated, { status: "pending" as const }],
    [COHORT_EXCLUSION.unresolvedGame, { gameId: null }],
    [COHORT_EXCLUSION.unresolvedGpu, { gpuId: null }],
    [COHORT_EXCLUSION.unprofiled, { methodologyManifestVersion: null }],
    [COHORT_EXCLUSION.capabilityUnestablished, { capabilityManifestVersion: null }],
    [COHORT_EXCLUSION.warmup, { isWarmup: true }],
    [COHORT_EXCLUSION.setMember, { benchmarkSetId: "set-1" }],
  ])("returns %s for its independent gate", (reason, override) => {
    expect(cohortExclusionReasons({ ...eligible, ...override })).toContain(reason);
  });

  it("rejects an older capability contract without flagging the run", () => {
    expect(
      cohortExclusionReasons({
        ...eligible,
        capabilityManifestVersion: CAPABILITY_MANIFEST_VERSION - 1,
      }),
    ).toEqual([COHORT_EXCLUSION.capabilityUnestablished]);
  });
});

describe("cohortEligibilitySql", () => {
  it("composes every aggregate-read gate under one versioned definition", () => {
    expect(COHORT_DEFINITION_VERSION).toBe(2);
    const sql = cohortEligibilitySql("r");
    for (const predicate of [
      "r.visibility = 'public'",
      "r.status = 'validated'",
      "r.game_id is not null",
      "r.gpu_hardware_id is not null",
      "r.methodology_manifest_version is not null",
      "r.capability_manifest_version >=",
      "r.is_warmup = false",
      "r.benchmark_set_id is null",
    ]) {
      expect(sql).toContain(predicate);
    }
  });

  it("lets the benchmark-set variance read retain raw members and warm-ups", () => {
    const sql = cohortEligibilitySql("r", {
      allowWarmups: true,
      allowBenchmarkSetMembers: true,
    });
    expect(sql).not.toContain("r.is_warmup = false");
    expect(sql).not.toContain("r.benchmark_set_id is null");
    expect(sql).toContain("r.capability_manifest_version >=");
  });
});

describe("cohortObservationsSql (§17.0.2)", () => {
  const sql = cohortObservationsSql();

  it("streams non-set runs individually and gates them like the cohort predicate", () => {
    // The individual branch keeps the default set-member exclusion so raw
    // members never double-count alongside their representative.
    expect(sql).toContain("from runs r");
    expect(sql).toContain("r.benchmark_set_id is null");
    expect(sql).toContain("union all");
  });

  it("collapses each set to one median-member representative", () => {
    // One representative per set: median position over avg_fps, warm-ups out.
    expect(sql).toContain("partition by r.benchmark_set_id order by s.avg_fps, r.id");
    expect(sql).toContain("ranked.rn = (ranked.member_count + 1) / 2");
    expect(sql).toContain("r.benchmark_set_id is not null");
    expect(sql).toContain("r.is_warmup = false");
  });

  it("propagates read options to both observation branches", () => {
    const ownerScoped = cohortObservationsSql({ requireCurrentCapabilityManifest: false });
    expect(ownerScoped).not.toContain("r.capability_manifest_version >=");
  });
});
