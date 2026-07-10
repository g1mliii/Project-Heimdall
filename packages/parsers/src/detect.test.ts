/**
 * Auto-detection coverage: every real fixture must parse under the source it
 * belongs to WITHOUT being told the source — this is what keeps the marker
 * tables honest when parser column aliases change.
 */

import { describe, expect, it } from "vitest";
import type { CaptureSource } from "@heimdall/shared";
import { parseAnyCapture } from "./detect";
import { readFixture } from "./testing/fixtures";

const CASES: { fixture: string; source: CaptureSource }[] = [
  { fixture: "capframex/csv/nvidia-full-sensors.csv", source: "capframex" },
  { fixture: "capframex/csv/amd-decimal-comma.csv", source: "capframex" },
  { fixture: "capframex/json/nvidia-capture.json", source: "capframex" },
  { fixture: "presentmon/v1-basic.csv", source: "presentmon" },
  { fixture: "presentmon/v2-basic.csv", source: "presentmon" },
  { fixture: "presentmon/v2-gpu-telemetry.csv", source: "presentmon" },
  { fixture: "mangohud/nvidia-basic.csv", source: "mangohud" },
];

describe("parseAnyCapture", () => {
  it.each(CASES)("detects $fixture as $source", ({ fixture, source }) => {
    const result = parseAnyCapture(readFixture(fixture));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.source).toBe(source);
      expect(result.capture.frames.length).toBeGreaterThan(0);
    }
  });

  it("returns a typed error for garbage input", () => {
    const result = parseAnyCapture(readFixture("malformed/binary-garbage.bin"));
    expect(result.ok).toBe(false);
  });
});
