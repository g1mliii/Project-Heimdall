import { describe, expect, it } from "vitest";
import { frameSampleSchema } from "@heimdall/shared";

import { parseMangoHud } from "./mangohud";
import { readFixture, readFixtureText } from "./testing/fixtures";
import { expectClose, unwrapOk } from "./testing/assertions";

const parseOk = (input: string | Uint8Array) => unwrapOk(parseMangoHud(input));

describe("parseMangoHud (§8)", () => {
  it("parses frame rows below the sysinfo block", () => {
    const { value, warnings } = parseOk(readFixture("mangohud/nvidia-basic.csv"));
    expect(value.source).toBe("mangohud");
    expect(value.parserVersion).toBe("mangohud@1.0.0");
    expect(value.frames).toHaveLength(10);
    expect(warnings).toEqual([]);
    expectClose(value.frames[0], {
      timeMs: 0,
      frameTimeMs: 10,
      gpuLoadPct: 95,
      gpuClockMhz: 2610,
      gpuPowerW: 215,
      vramUsedMb: 7680, // 7.5 GiB × 1024
      cpuLoadPct: 35,
    });
    for (const frame of value.frames) {
      expect(frameSampleSchema.safeParse(frame).success).toBe(true);
    }
  });

  it("converts elapsed nanoseconds to relative milliseconds", () => {
    const { value } = parseOk(readFixture("mangohud/nvidia-basic.csv"));
    expect(value.frames.map((f) => f.timeMs)).toEqual([0, 10, 20, 30, 40, 70, 80, 90, 100, 110]);
  });

  it("extracts the sysinfo header into a HardwareSnapshot", () => {
    const { value } = parseOk(readFixture("mangohud/nvidia-basic.csv"));
    expect(value.hardware).toEqual({
      gpu: "NVIDIA GeForce RTX 4070",
      cpu: "AMD Ryzen 7 7800X3D",
      gpuVendor: "nvidia",
      ramGb: 32, // 32768 MB sysinfo value
      os: "Arch Linux",
      gpuDriver: "NVIDIA 555.58.02",
    });
  });

  it("preserves Mesa's version string for Linux driver-currency checks", () => {
    const { value } = parseOk(readFixture("mangohud/amd-mesa-basic.csv"));
    expect(value.hardware).toMatchObject({
      gpuVendor: "amd",
      os: "Arch Linux",
      gpuDriver: "Mesa 26.1.4",
    });
  });

  it("still parses frames when the sysinfo block is missing", () => {
    const text = readFixtureText("mangohud/nvidia-basic.csv");
    const withoutSysinfo = text.split("\n").slice(2).join("\n");
    const { value } = parseOk(withoutSysinfo);
    expect(value.hardware).toBeUndefined();
    expect(value.frames).toHaveLength(10);
  });

  it("falls back to cumulative frame times when elapsed is absent", () => {
    const rows = ["fps,frametime", "100,10", "100,10", "33.3,30", "100,10"];
    const { value } = parseOk(rows.join("\n"));
    expect(value.frames.map((f) => f.timeMs)).toEqual([0, 10, 20, 50]);
  });

  it("returns typed errors on junk", () => {
    expect(parseMangoHud("")).toMatchObject({ ok: false, error: { code: "empty-input" } });
    expect(parseMangoHud("os,cpu,gpu\nA,B,C")).toMatchObject({
      ok: false,
      error: { code: "missing-columns", source: "mangohud" },
    });
  });
});
