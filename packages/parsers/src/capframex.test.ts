import fc from "fast-check";
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
  it("parses the anonymized CapFrameX 1.8.6 AMD SensorData2 capture", () => {
    const { value, warnings } = parseOk("capframex/json/amd-sensordata2-real.json");
    expect(value.frames).toHaveLength(120);
    expect(warnings).toEqual([]);
    expectClose(value.frames[0], {
      timeMs: 0,
      frameTimeMs: 5.3232,
      cpuBusyMs: 5.2226,
      gpuBusyMs: 15.5204,
    });
    expect(value.frames[0]!.gpuLoadPct).toBeUndefined();
    expectClose(value.frames[2], {
      timeMs: 25.7041999993817,
      frameTimeMs: 6.2446,
      cpuBusyMs: 6.1462,
      gpuBusyMs: 15.1737,
      gpuLoadPct: 100,
      gpuClockMhz: 2724,
      gpuPowerW: 316,
      vramUsedMb: 11_756,
      cpuLoadPct: 35.23856735229492,
    });
  });

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

  it("maps periodic SensorData2 channels and frame-aligned CPU/GPU active arrays", () => {
    const result = parseCapFrameX(
      JSON.stringify({
        Runs: [
          {
            CaptureData: {
              TimeInSeconds: [0, 0.1, 0.3],
              MsBetweenPresents: [10, 10, 10],
              CpuActive: [4, 5, 6],
              GpuActive: [8, 9, 10],
            },
            SensorData2: [
              {
                MeasureTime: { Name: "MeasureTime", Type: "Time", Values: [0.02, 0.25] },
                gpuLoad: { Name: "GPU Core", Type: "Load", Values: [50, 75] },
                gpuClock: { Name: "GPU Core", Type: "Clock", Values: [2400, 2500] },
                gpuPower: { Name: "GPU TBP", Type: "Power", Values: [300, 310] },
                gpuMemory: {
                  Name: "GPU Memory Dedicated",
                  Type: "Data",
                  Values: [10, 10.5],
                },
                cpuLoad: { Name: "CPU Total", Type: "Load", Values: [30, 40] },
              },
            ],
          },
        ],
      }),
    );
    const { value, warnings } = unwrapOk(result);
    expect(warnings).toEqual([]);
    expectClose(value.frames[0], {
      timeMs: 0,
      frameTimeMs: 10,
      cpuBusyMs: 4,
      gpuBusyMs: 8,
    });
    expect(value.frames[0]!.gpuLoadPct).toBeUndefined();
    expectClose(value.frames[1], {
      timeMs: 100,
      frameTimeMs: 10,
      cpuBusyMs: 5,
      gpuBusyMs: 9,
      gpuLoadPct: 50,
      gpuClockMhz: 2400,
      gpuPowerW: 300,
      vramUsedMb: 10_240,
      cpuLoadPct: 30,
    });
    expectClose(value.frames[2], {
      timeMs: 300,
      frameTimeMs: 10,
      cpuBusyMs: 6,
      gpuBusyMs: 10,
      gpuLoadPct: 75,
      gpuClockMhz: 2500,
      gpuPowerW: 310,
      vramUsedMb: 10_752,
      cpuLoadPct: 40,
    });
  });

  it("keeps frame parsing total when SensorData2 arrays have mismatched lengths", () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 1, max: 40 }), { minLength: 1, maxLength: 100 }),
        fc.array(fc.integer({ min: 0, max: 100 }), { maxLength: 100 }),
        fc.array(fc.integer({ min: 0, max: 50 }), { maxLength: 100 }),
        (frameTimes, sensorValues, timeSteps) => {
          let sensorTime = 0;
          const sensorTimes = timeSteps.map((step) => (sensorTime += step / 1000));
          const result = parseCapFrameX(
            JSON.stringify({
              Runs: [
                {
                  CaptureData: {
                    MsBetweenPresents: frameTimes,
                    CpuActive: sensorValues,
                    GpuActive: sensorValues.slice(0, Math.floor(sensorValues.length / 2)),
                  },
                  SensorData2: [
                    {
                      MeasureTime: {
                        Name: "MeasureTime",
                        Type: "Time",
                        Values: sensorTimes,
                      },
                      gpuLoad: {
                        Name: "GPU Core",
                        Type: "Load",
                        Values: sensorValues,
                      },
                    },
                  ],
                },
              ],
            }),
          );
          expect(result.ok).toBe(true);
          if (result.ok) expect(result.value.frames).toHaveLength(frameTimes.length);
        },
      ),
    );
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

  it("keeps concatenated runs monotonic when capture timestamps exceed frame-time sums", () => {
    const result = parseCapFrameX(
      JSON.stringify({
        Runs: [
          { CaptureData: { TimeInSeconds: [0, 1], MsBetweenPresents: [10, 10] } },
          { CaptureData: { TimeInSeconds: [0, 0.01], MsBetweenPresents: [10, 10] } },
        ],
      }),
    );
    const { value } = unwrapOk(result);
    expect(value.frames.map((frame) => frame.timeMs)).toEqual([0, 1000, 1010, 1020]);
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

  it("skips implausibly tiny positive frame times", () => {
    const frameTimes = Array.from({ length: 40 }, () => 10);
    frameTimes[7] = 1e-300;
    const result = parseCapFrameX(
      JSON.stringify({ Runs: [{ CaptureData: { MsBetweenPresents: frameTimes } }] }),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.frames).toHaveLength(39);
      expect(result.warnings).toContainEqual(expect.objectContaining({ code: "skipped-rows", count: 1 }));
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

  it("skips implausibly tiny positive frame times", () => {
    const rows = Array.from({ length: 40 }, (_, i) => `${(i * 0.01).toFixed(2)},10`);
    rows[7] = "0.07,1e-300";
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
