import { describe, expect, it } from "vitest";

import { POINT_ONE_PERCENT_LOW_CONFIDENCE_FRAMES, STUTTER } from "./constants";

describe("stutter thresholds (§9.1)", () => {
  it("requires a meaningful multiple of the median", () => {
    expect(STUTTER.medianMultiplier).toBeGreaterThan(1);
  });

  it("keeps an absolute floor so high-fps micro-blips don't count", () => {
    // 20ms ≈ a missed frame at 50 FPS — anything lower would flag ordinary
    // variance on 200+ FPS captures as stutter.
    expect(STUTTER.minFrameTimeMs).toBeGreaterThanOrEqual(10);
  });
});

describe("confidence thresholds (§9.2)", () => {
  it("orders the confidence tiers", () => {
    expect(POINT_ONE_PERCENT_LOW_CONFIDENCE_FRAMES.high).toBeGreaterThan(
      POINT_ONE_PERCENT_LOW_CONFIDENCE_FRAMES.medium,
    );
    expect(POINT_ONE_PERCENT_LOW_CONFIDENCE_FRAMES.medium).toBeGreaterThan(0);
  });
});
