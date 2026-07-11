/**
 * Pins generator↔summary parity for the shared synthetic fixture (Phase 5 §14).
 * `@heimdall/shared` cannot import this package, so the guarantee that
 * `makeSyntheticFrames()` output drives the chart/visual tests with a truthful
 * summary lives here, next to the canonical math.
 */

import { describe, expect, it } from "vitest";
import {
  SYNTHETIC_GENERATED_FRACTION,
  SYNTHETIC_SPIKE_COUNT,
  makeSyntheticFrames,
  runSummarySchema,
} from "@heimdall/shared";

import { computeRunSummary } from "./metrics";

describe("makeSyntheticFrames ↔ computeRunSummary parity", () => {
  const frames = makeSyntheticFrames({ seed: 7, count: 7200 });
  const summary = computeRunSummary(frames);

  it("produces a schema-valid summary", () => {
    expect(runSummarySchema.safeParse(summary).success).toBe(true);
  });

  it("counts exactly the injected spikes as stutters", () => {
    expect(summary.stutterCount).toBe(SYNTHETIC_SPIKE_COUNT);
  });

  it("reports the exact generated fraction", () => {
    expect(summary.generatedFramePct).toBe(SYNTHETIC_GENERATED_FRACTION);
  });

  it("lands near the design-kit story: ~120 FPS, 60s, high confidence", () => {
    expect(summary.avgFps).toBeGreaterThan(100);
    expect(summary.avgFps).toBeLessThan(125);
    expect(summary.durationSeconds).toBeGreaterThan(55);
    expect(summary.durationSeconds).toBeLessThan(70);
    expect(summary.pointOnePercentLowConfidence).toBe("high");
    expect(summary.sampleCount).toBe(7200);
  });
});
