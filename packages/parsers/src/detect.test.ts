/**
 * Auto-detection coverage: every real fixture must parse under the source it
 * belongs to WITHOUT being told the source — this is what keeps the marker
 * tables honest when parser column aliases change.
 */

import { describe, expect, it } from "vitest";
import type { CaptureSource } from "@heimdall/shared";
import { detectionOrder, parseAnyCapture } from "./detect";
import { encodeUtf16WithBom } from "./testing/encoding";
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

  it("prefers a bare MangoHud frame-time log over generic PresentMon parsing", () => {
    const input = ["fps,frametime", "100,10", "100,10", "33.3,30", "100,10"].join("\n");

    expect(detectionOrder(input)[0]).toBe("mangohud");
    const result = parseAnyCapture(input);
    expect(result).toMatchObject({ ok: true, source: "mangohud" });
  });

  it("keeps a PresentMon CSV with an FPS column on the timestamp-aware parser", () => {
    const input = ["FrameTime,TimeInSeconds,FPS", "10,0,100", "10,0.01,100"].join("\n");

    expect(parseAnyCapture(input)).toMatchObject({ ok: true, source: "presentmon" });
  });

  it("forwards a frame cap to the selected parser before it retains every row", () => {
    const input = [
      "SwapChainAddress,TimeInSeconds,MsBetweenPresents",
      "0x1,0,10",
      "0x1,0.01,10",
      "0x1,0.02,10",
    ].join("\n");

    expect(parseAnyCapture(input, { maxFrames: 2 })).toMatchObject({
      ok: false,
      error: { code: "too-many-frames", source: "presentmon" },
    });
  });

  it.each(["le", "be"] as const)("detects a UTF-16%s PresentMon v1 capture", (endian) => {
    const input = encodeUtf16WithBom(
      [
        "SwapChainAddress,TimeInSeconds,MsBetweenPresents",
        "0x1,0,10",
        "0x1,0.01,10",
        "0x1,0.02,10",
      ].join("\n"),
      endian,
    );

    expect(detectionOrder(input)[0]).toBe("presentmon");
    const result = parseAnyCapture(input);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.source).toBe("presentmon");
    }
  });
});
