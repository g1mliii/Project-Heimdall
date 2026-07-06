import { describe, expect, it } from "vitest";
import { captureSourceSchema, type FrameSample } from "@heimdall/shared";

import {
  detectAvailableSensors,
  expectedSensors,
  SENSOR_AVAILABILITY,
  SENSOR_FIELDS,
} from "./sensor-availability";
import { parseCapFrameX } from "./capframex";
import { parsePresentMon } from "./presentmon";
import { readFixture } from "./testing/fixtures";

const VENDORS = ["nvidia", "amd", "intel"] as const;

describe("SENSOR_AVAILABILITY matrix completeness (§7.3)", () => {
  it("has a cell for every source × real vendor, covering every sensor field", () => {
    for (const source of captureSourceSchema.options) {
      for (const vendor of VENDORS) {
        const matrixCell = SENSOR_AVAILABILITY[source][vendor];
        expect(matrixCell, `${source}×${vendor}`).toBeDefined();
        expect(Object.keys(matrixCell!.availability).sort()).toEqual([...SENSOR_FIELDS].sort());
      }
    }
  });

  it("is honest about provenance: no cell claims verified-real yet", () => {
    // Flipping a cell to verified-real requires landing the real export in
    // fixtures/ in the same PR (see fixtures/README.md wanted-list).
    for (const source of captureSourceSchema.options) {
      for (const vendor of VENDORS) {
        expect(SENSOR_AVAILABILITY[source][vendor]!.provenance).toBe("synthetic");
      }
    }
  });
});

describe("expectedSensors", () => {
  it("returns only 'expected' fields, and [] for unknown vendors", () => {
    expect(expectedSensors("capframex", "nvidia")).toEqual([
      "gpuLoadPct",
      "gpuClockMhz",
      "gpuPowerW",
      "vramUsedMb",
      "cpuLoadPct",
    ]);
    expect(expectedSensors("presentmon", "nvidia")).toEqual([]);
    expect(expectedSensors("capframex", "unknown")).toEqual([]);
  });
});

describe("detectAvailableSensors — per-run truth", () => {
  it("reports fields present on at least one frame", () => {
    const frames: FrameSample[] = [
      { timeMs: 0, frameTimeMs: 10 },
      { timeMs: 10, frameTimeMs: 10, gpuLoadPct: 97, cpuBusyMs: 5 },
    ];
    expect(detectAvailableSensors(frames)).toEqual(["gpuLoadPct", "cpuBusyMs"]);
    expect(detectAvailableSensors([])).toEqual([]);
  });

  it("matches what the parsers actually produced for the fixtures", () => {
    const full = parseCapFrameX(readFixture("capframex/csv/nvidia-full-sensors.csv"));
    if (!full.ok) throw new Error(full.error.code);
    expect(detectAvailableSensors(full.value.frames)).toEqual([
      "gpuLoadPct",
      "gpuClockMhz",
      "gpuPowerW",
      "vramUsedMb",
      "cpuLoadPct",
      "gpuBusyMs",
    ]);

    const sparse = parseCapFrameX(readFixture("capframex/csv/intel-missing-sensors.csv"));
    if (!sparse.ok) throw new Error(sparse.error.code);
    expect(detectAvailableSensors(sparse.value.frames)).toEqual([]);

    const v2 = parsePresentMon(readFixture("presentmon/v2-basic.csv"));
    if (!v2.ok) throw new Error(v2.error.code);
    expect(detectAvailableSensors(v2.value.frames)).toEqual(["cpuBusyMs", "gpuBusyMs"]);
  });
});
