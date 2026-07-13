import { describe, expect, it } from "vitest";
import { frameSampleSchema } from "@heimdall/shared";

import { parsePresentMon } from "./presentmon";
import { readFixture } from "./testing/fixtures";
import { expectClose, unwrapOk } from "./testing/assertions";

const parseOk = (relPath: string) => unwrapOk(parsePresentMon(readFixture(relPath)));

describe("parsePresentMon — v1 (§8)", () => {
  it("parses MsBetweenPresents/TimeInSeconds with no sensors and no hardware", () => {
    const { value, warnings } = parseOk("presentmon/v1-basic.csv");
    expect(value.source).toBe("presentmon");
    expect(value.parserVersion).toBe("presentmon@1.0.0");
    expect(value.hardware).toBeUndefined();
    expect(value.frames).toHaveLength(10);
    expect(value.frames[0]).toEqual({ timeMs: 0, frameTimeMs: 10 });
    // v1 has no sensor columns at all, so there is nothing to warn about.
    expect(warnings).toEqual([]);
    for (const frame of value.frames) {
      expect(frameSampleSchema.safeParse(frame).success).toBe(true);
    }
  });
});

describe("parsePresentMon — v2 (§8, CPU/GPU busy)", () => {
  it("captures CPUBusy/GPUBusy as bottleneck fields", () => {
    const { value, warnings } = parseOk("presentmon/v2-basic.csv");
    expect(value.frames).toHaveLength(10);
    expectClose(value.frames[0], { timeMs: 0, frameTimeMs: 10, cpuBusyMs: 6, gpuBusyMs: 9.5 });
    expectClose(value.frames[4], { timeMs: 40, frameTimeMs: 30, cpuBusyMs: 20, gpuBusyMs: 29 });
    // Telemetry columns are opt-in and absent here → warning, not error.
    const missing = warnings.find((w) => w.code === "missing-sensors");
    expect(missing?.fields).toEqual(
      expect.arrayContaining(["gpuLoadPct", "gpuClockMhz", "gpuPowerW", "vramUsedMb"]),
    );
  });

  it("normalizes CPUStartTime so the first frame is at t=0", () => {
    // v2-basic's CPUStartTime column starts at 3.5s into the session.
    const { value } = parseOk("presentmon/v2-basic.csv");
    expect(value.frames[0]!.timeMs).toBe(0);
    expect(value.frames[9]!.timeMs).toBeCloseTo(110, 6);
  });

  it("maps opt-in GPU telemetry columns onto sensor fields", () => {
    const { value, warnings } = parseOk("presentmon/v2-gpu-telemetry.csv");
    expectClose(value.frames[0], {
      timeMs: 0,
      frameTimeMs: 10,
      cpuBusyMs: 6,
      gpuBusyMs: 9.5,
      gpuLoadPct: 96,
      gpuClockMhz: 2520,
      gpuPowerW: 210,
      vramUsedMb: 7800,
    });
    expect(warnings.find((w) => w.code === "missing-sensors")).toBeUndefined();
    for (const frame of value.frames) {
      expect(frameSampleSchema.safeParse(frame).success).toBe(true);
    }
  });
});

describe("parsePresentMon — stream selection & frame generation (§8)", () => {
  const header = "Application,ProcessID,SwapChainAddress,FrameType,CPUStartTime,FrameTime";
  const row = (app: string, pid: string, swap: string, type: string, t: number, ft: number) =>
    `${app},${pid},${swap},${type},${t.toFixed(3)},${ft}`;

  it("keeps only the dominant process/swapchain stream and warns", () => {
    const lines = [header];
    for (let i = 0; i < 10; i++) lines.push(row("game.exe", "1234", "0xAAAA", "Application", 3.5 + i * 0.01, 10));
    for (let i = 0; i < 4; i++) lines.push(row("dwm.exe", "888", "0xBBBB", "Application", 3.5 + i * 0.016, 16.6));
    const { value, warnings } = unwrapOk(parsePresentMon(lines.join("\n")));
    expect(value.frames).toHaveLength(10);
    expect(value.frames.every((f) => f.frameTimeMs === 10)).toBe(true);
    expect(warnings).toContainEqual(
      expect.objectContaining({ code: "multiple-streams", count: 4 }),
    );
  });

  it("reads semantics from the dominant stream rather than the file's first stream", () => {
    const semanticHeader =
      "Application,ProcessID,SwapChainAddress,FrameType,CPUStartTime,FrameTime,Runtime,PresentMode,AllowsTearing,SyncInterval";
    const semanticRow = (
      app: string,
      pid: string,
      swap: string,
      t: number,
      runtime: string,
      mode: string,
      allowsTearing: number,
      syncInterval: number,
    ) =>
      `${app},${pid},${swap},Application,${t.toFixed(3)},10,${runtime},${mode},${allowsTearing},${syncInterval}`;
    const lines = [semanticHeader];
    // The shorter overlay stream comes first, which used to determine the
    // persisted semantics even though its frame rows were discarded.
    for (let i = 0; i < 4; i++) {
      lines.push(semanticRow("overlay.exe", "888", "0xBBBB", 3.5 + i * 0.016, "D3D11", "Composed", 1, 0));
    }
    for (let i = 0; i < 10; i++) {
      lines.push(
        semanticRow(
          "game.exe",
          "1234",
          "0xAAAA",
          3.5 + i * 0.01,
          "D3D12",
          "Hardware Composed: Independent Flip",
          0,
          1,
        ),
      );
    }

    const { value } = unwrapOk(parsePresentMon(lines.join("\n")));
    expect(value.captureSemantics).toMatchObject({
      graphicsApi: "dx12",
      presentationMode: "hardware-composed-flip",
      syncMode: "vsync",
    });
  });

  it("does not warn when a single stream is present", () => {
    const { warnings } = parseOk("presentmon/v2-basic.csv");
    expect(warnings.find((w) => w.code === "multiple-streams")).toBeUndefined();
  });

  it("marks non-Application FrameType rows as generated (DLSS3/FSR3/XeSS)", () => {
    const lines = [header];
    for (let i = 0; i < 6; i++) {
      lines.push(row("game.exe", "1234", "0xAAAA", i % 2 === 1 ? "AMD AFMF" : "Application", 3.5 + i * 0.01, 10));
    }
    const { value } = unwrapOk(parsePresentMon(lines.join("\n")));
    expect(value.frames.map((f) => f.generated === true)).toEqual([
      false, true, false, true, false, true,
    ]);
  });
});

describe("parsePresentMon — errors", () => {
  it("returns empty-input / missing-columns / unrecognized-format", () => {
    expect(parsePresentMon("")).toMatchObject({ ok: false, error: { code: "empty-input" } });
    expect(parsePresentMon("a,b,c\n1,2,3")).toMatchObject({
      ok: false,
      error: { code: "missing-columns", source: "presentmon" },
    });
    expect(parsePresentMon("just some prose\nwith no structure")).toMatchObject({
      ok: false,
      error: { code: "unrecognized-format" },
    });
  });
});
