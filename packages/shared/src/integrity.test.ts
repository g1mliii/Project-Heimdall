import { describe, expect, it } from "vitest";

import { OUTLIER, PHYSICS, reconcileGeneratedFrameTech } from "./integrity";

describe("integrity thresholds", () => {
  it("requires a meaningful cold-start sample size before aggregating (§17.4)", () => {
    expect(OUTLIER.minSampleSize).toBeGreaterThanOrEqual(30);
  });

  it("keeps the server-recompute tolerance tight (§11.5)", () => {
    expect(PHYSICS.recomputeTolerance).toBeGreaterThan(0);
    expect(PHYSICS.recomputeTolerance).toBeLessThanOrEqual(0.05);
  });

  it("exposes positive outlier thresholds", () => {
    expect(OUTLIER.madZScoreThreshold).toBeGreaterThan(0);
    expect(OUTLIER.sigmaThreshold).toBeGreaterThan(0);
  });

});

/**
 * Frame-generation reconciliation (§11.5, §22.11).
 *
 * The rule that matters: `none` is a positive claim and must be DECLARED, never
 * derived from a capture that had no way to look. Two earlier attempts got this
 * wrong in the same direction — first by treating a recomputed 0 as decisive,
 * then by treating the mere presence of a `FrameType` column as evidence. Both
 * sent an AMD frame-generated run out as "no frame generation" at roughly twice
 * its real rendering rate.
 */
describe("reconcileGeneratedFrameTech", () => {
  describe("when the recompute observed generated frames", () => {
    it("names the declared tech, because the observation corroborates it", () => {
      expect(reconcileGeneratedFrameTech("fsr3", 0.5)).toBe("fsr3");
      expect(reconcileGeneratedFrameTech("dlss3", 12)).toBe("dlss3");
    });

    it("overrules a declaration that denies what the frames show", () => {
      // An observation beats a declaration in the one direction the data can
      // actually support: generation happened, whatever the uploader said.
      expect(reconcileGeneratedFrameTech("none", 0.5)).toBe("unknown");
      expect(reconcileGeneratedFrameTech("unknown", 0.5)).toBe("unknown");
    });
  });

  describe("when the recompute observed none", () => {
    it("never manufactures `none` — an undeclared run stays unknown", () => {
      // The AMD case: 14,241 rows, every one `Application`, frame generation
      // demonstrably on. A zero count is not evidence of absence.
      expect(reconcileGeneratedFrameTech("unknown", 0)).toBe("unknown");
    });

    it("takes a declared tech at face value", () => {
      // Same trust level as `upscaler` or `settingsPreset`: unverifiable
      // declarations that are already comparability key fields.
      expect(reconcileGeneratedFrameTech("fsr3", 0)).toBe("fsr3");
      expect(reconcileGeneratedFrameTech("xess", 0)).toBe("xess");
    });

    it("keeps a declared `none`, which is the only way a run earns it", () => {
      expect(reconcileGeneratedFrameTech("none", 0)).toBe("none");
    });
  });

  it("is idempotent, because the client applies it and the server re-applies it", () => {
    for (const declared of ["none", "unknown", "fsr3", "dlss3", "xess"] as const) {
      for (const pct of [0, 0.5, 47]) {
        const once = reconcileGeneratedFrameTech(declared, pct);
        expect(reconcileGeneratedFrameTech(once, pct)).toBe(once);
      }
    }
  });
});
