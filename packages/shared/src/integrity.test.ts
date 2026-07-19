import { describe, expect, it } from "vitest";

import { OUTLIER, PHYSICS } from "./integrity";

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
