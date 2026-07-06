import { describe, expect, it } from "vitest";
import { frameSampleSchema } from "@heimdall/shared";

import { parseCapFrameX } from "./capframex";
import { readFixture } from "./testing/fixtures";
import { expectClose, unwrapOk } from "./testing/assertions";

const parseOk = (relPath: string) => unwrapOk(parseCapFrameX(readFixture(relPath)));

describe("parseCapFrameX — CSV (§7.1)", () => {
  it("parses the sensor-complete export", () => {
    const { value, warnings } = parseOk("capframex/csv/nvidia-full-sensors.csv");
    expect(value.source).toBe("capframex");
    expect(value.parserVersion).toBe("capframex@1.0.0");
    expect(value.frames).toHaveLength(20);
    expect(value.hardware).toBeUndefined(); // bare CSV carries no hardware block
    expect(warnings).toEqual([]);
    expectClose(value.frames[0], {
      timeMs: 0,
      frameTimeMs: 8,
      gpuBusyMs: 7,
      gpuLoadPct: 97,
      gpuClockMhz: 2610,
      gpuPowerW: 220,
      vramUsedMb: 9200,
      cpuLoadPct: 41,
    });
  });

  it("every parsed frame passes frameSampleSchema element-wise", () => {
    for (const fixture of [
      "capframex/csv/nvidia-full-sensors.csv",
      "capframex/csv/amd-decimal-comma.csv",
      "capframex/csv/intel-missing-sensors.csv",
      "capframex/csv/columns-reordered.csv",
    ]) {
      const { value } = parseOk(fixture);
      for (const frame of value.frames) {
        expect(frameSampleSchema.safeParse(frame).success, fixture).toBe(true);
      }
    }
  });

  it("handles German-locale exports: semicolon delimiter + decimal comma (§7.2)", () => {
    const { value } = parseOk("capframex/csv/amd-decimal-comma.csv");
    expect(value.frames).toHaveLength(20);
    expect(value.frames[0]!.gpuPowerW).toBe(263.5);
    expect(value.frames[0]!.cpuLoadPct).toBe(37.5);
    expect(value.frames[9]!.frameTimeMs).toBe(50);
  });

  it("is order-independent: reordered columns parse identically (§7.2)", () => {
    const baseline = parseOk("capframex/csv/nvidia-full-sensors.csv");
    const reordered = parseOk("capframex/csv/columns-reordered.csv");
    expect(reordered.value.frames).toEqual(baseline.value.frames);
  });

  it("treats missing sensors as a warning, never an error (§7.2)", () => {
    const { value, warnings } = parseOk("capframex/csv/intel-missing-sensors.csv");
    expect(value.frames).toHaveLength(20);
    expect(value.frames[0]).toEqual({ timeMs: 0, frameTimeMs: 8 });
    const missing = warnings.find((w) => w.code === "missing-sensors");
    expect(missing).toBeDefined();
    expect(missing!.fields).toEqual(
      expect.arrayContaining(["gpuLoadPct", "gpuClockMhz", "gpuPowerW", "vramUsedMb", "cpuLoadPct"]),
    );
  });

  it("accepts string input as well as bytes", () => {
    const text = "MsBetweenPresents,TimeInSeconds\n10,0\n10,0.010\n";
    const result = parseCapFrameX(text);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.frames).toHaveLength(2);
  });
});

describe("parseCapFrameX — JSON (§7.1 hardware extraction)", () => {
  it("parses frames + sensors from Runs[].CaptureData", () => {
    const { value, warnings } = parseOk("capframex/json/nvidia-capture.json");
    expect(value.frames).toHaveLength(20);
    expect(warnings).toEqual([]);
    expectClose(value.frames[19], {
      timeMs: 206,
      frameTimeMs: 8,
      gpuBusyMs: 7,
      gpuLoadPct: 97,
      gpuClockMhz: 2610,
      gpuPowerW: 220,
      vramUsedMb: 9200,
      cpuLoadPct: 41,
    });
    for (const frame of value.frames) {
      expect(frameSampleSchema.safeParse(frame).success).toBe(true);
    }
  });

  it("extracts the hardware snapshot and infers the GPU vendor", () => {
    const { value } = parseOk("capframex/json/nvidia-capture.json");
    expect(value.hardware).toEqual({
      gpu: "NVIDIA GeForce RTX 4070",
      cpu: "AMD Ryzen 7 7800X3D",
      gpuVendor: "nvidia",
      ramGb: 32,
      os: "Windows 11 24H2",
      gpuDriver: "566.36",
      resolution: "2560x1440",
    });
  });

  it("omits hardware when gpu/cpu are not recoverable", () => {
    const result = parseCapFrameX(
      JSON.stringify({ Runs: [{ CaptureData: { MsBetweenPresents: [8, 9, 10] } }] }),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.hardware).toBeUndefined();
      expect(result.value.frames).toHaveLength(3);
      // No TimeInSeconds array → cumulative-sum fallback.
      expect(result.value.frames.map((f) => f.timeMs)).toEqual([0, 8, 17]);
    }
  });

  it("returns invalid-json on truncated JSON", () => {
    const result = parseCapFrameX('{"Runs": [');
    expect(result).toMatchObject({ ok: false, error: { code: "invalid-json", source: "capframex" } });
  });

  it("returns missing-columns when CaptureData/MsBetweenPresents is absent", () => {
    const result = parseCapFrameX(JSON.stringify({ Runs: [{ CaptureData: {} }] }));
    expect(result).toMatchObject({ ok: false, error: { code: "missing-columns" } });
  });
});

describe("parseCapFrameX — row policy", () => {
  const header = "TimeInSeconds,MsBetweenPresents\n";

  it("skips isolated bad rows with a skipped-rows warning", () => {
    const rows = Array.from({ length: 40 }, (_, i) => `${(i * 0.01).toFixed(2)},10`);
    rows[7] = "garbage,not-a-number";
    const result = parseCapFrameX(header + rows.join("\n"));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.frames).toHaveLength(39);
      expect(result.warnings).toContainEqual(expect.objectContaining({ code: "skipped-rows", count: 1 }));
    }
  });

  it("skips rows whose timestamp jumps backwards mid-stream", () => {
    const rows = Array.from({ length: 40 }, (_, i) => `${(i * 0.01).toFixed(2)},10`);
    rows[20] = "0.05,10"; // above the baseline, but earlier than the previous row
    const result = parseCapFrameX(header + rows.join("\n"));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.frames).toHaveLength(39);
      expect(result.warnings).toContainEqual(expect.objectContaining({ code: "skipped-rows", count: 1 }));
      const times = result.value.frames.map((f) => f.timeMs);
      expect([...times].sort((a, b) => a - b)).toEqual(times);
    }
  });

  it("rejects the file when more than 5% of rows are bad", () => {
    const rows = Array.from({ length: 10 }, (_, i) => `${(i * 0.01).toFixed(2)},10`);
    rows[3] = "x,-5";
    const result = parseCapFrameX(header + rows.join("\n"));
    expect(result).toMatchObject({ ok: false, error: { code: "too-many-bad-rows" } });
  });

  it("returns no-valid-frames for a header with no surviving rows", () => {
    const result = parseCapFrameX(header);
    expect(result).toMatchObject({ ok: false, error: { code: "no-valid-frames" } });
  });

  it("returns empty-input for whitespace-only input", () => {
    expect(parseCapFrameX("  \n \t ")).toMatchObject({ ok: false, error: { code: "empty-input" } });
    expect(parseCapFrameX(new Uint8Array())).toMatchObject({ ok: false, error: { code: "empty-input" } });
  });
});
