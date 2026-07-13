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
import { listFixtureFiles, readFixture } from "./testing/fixtures";

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

  it("keeps provenance honest: a verified-real cell must carry matching evidence + a golden fixture on disk (16d.1)", () => {
    // Flipping a cell to verified-real requires landing the real export in
    // fixtures/ in the same PR (see fixtures/README.md flip procedure). This
    // passes vacuously while every cell is synthetic and becomes load-bearing
    // the moment one flips: provenance can never outrun the data.
    const allFixtures = new Set(listFixtureFiles());
    for (const source of captureSourceSchema.options) {
      for (const vendor of VENDORS) {
        const matrixCell = SENSOR_AVAILABILITY[source][vendor]!;
        if (matrixCell.provenance === "synthetic") {
          expect(matrixCell.evidence, `${source}×${vendor} synthetic cell carries no evidence`).toBeUndefined();
          continue;
        }
        const evidence = matrixCell.evidence;
        expect(evidence, `${source}×${vendor} verified-real cell has structured evidence`).toBeDefined();
        expect(evidence!.source).toBe(source);
        expect(evidence!.gpuVendor).toBe(vendor);
        expect(
          allFixtures.has(evidence!.fixture),
          `${source}×${vendor} verified-real fixture ${evidence!.fixture} exists on disk`,
        ).toBe(true);
        const expectedPath = evidence!.fixture.replace(/\.[^./]+$/, ".expected.json");
        expect(
          allFixtures.has(expectedPath),
          `${source}×${vendor} verified-real fixture has ${expectedPath}`,
        ).toBe(true);
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
