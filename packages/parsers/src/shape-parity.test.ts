/**
 * The Phase-3 Verify line: a CapFrameX export and a PresentMon CSV (and a
 * MangoHud log) must produce *identical* `RunSummary` shapes — same keys, all
 * schema-valid — so downstream code never branches on capture source.
 */

import { describe, expect, it } from "vitest";
import { runSummarySchema } from "@heimdall/shared";

import { parseCapture } from "./parse";
import { computeRunSummary } from "./metrics";
import { readFixture } from "./testing/fixtures";

const FIXTURES = [
  ["capframex", "capframex/csv/nvidia-full-sensors.csv"],
  ["capframex", "capframex/csv/amd-decimal-comma.csv"],
  ["capframex", "capframex/json/nvidia-capture.json"],
  ["presentmon", "presentmon/v1-basic.csv"],
  ["presentmon", "presentmon/v2-gpu-telemetry.csv"],
  ["mangohud", "mangohud/nvidia-basic.csv"],
] as const;

describe("RunSummary shape parity across sources (Phase 3 Verify)", () => {
  const summaries = FIXTURES.map(([source, file]) => {
    const result = parseCapture(source, readFixture(file));
    if (!result.ok) throw new Error(`${file}: ${result.error.code}`);
    return { file, summary: computeRunSummary(result.value.frames) };
  });

  it("every source's summary passes runSummarySchema", () => {
    for (const { file, summary } of summaries) {
      const parsed = runSummarySchema.safeParse(summary);
      expect(parsed.success, file).toBe(true);
    }
  });

  it("all sources produce the identical key set", () => {
    const [first, ...rest] = summaries;
    const referenceKeys = Object.keys(first!.summary).sort();
    expect(referenceKeys.length).toBeGreaterThan(0);
    for (const { file, summary } of rest) {
      expect(Object.keys(summary).sort(), `${file} vs ${first!.file}`).toEqual(referenceKeys);
    }
  });
});
