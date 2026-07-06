/**
 * Test-only serializers: FrameSample[] → synthetic capture text, used by the
 * round-trip property tests (parse(serialize(frames)) ≈ frames). They write
 * the same column names the alias tables read, with full float precision
 * (String(n) round-trips doubles exactly).
 */

import type { FrameSample } from "@heimdall/shared";

const cell = (value: number | undefined): string => (value === undefined ? "" : String(value));

export function serializeCapFrameXCsv(frames: readonly FrameSample[]): string {
  const lines = [
    "TimeInSeconds,MsBetweenPresents,MsGPUActive,GpuUsage,GpuClock,GpuPower,GpuMemUsage,CpuUsage",
  ];
  for (const f of frames) {
    lines.push(
      [
        String(f.timeMs / 1000),
        String(f.frameTimeMs),
        cell(f.gpuBusyMs),
        cell(f.gpuLoadPct),
        cell(f.gpuClockMhz),
        cell(f.gpuPowerW),
        cell(f.vramUsedMb),
        cell(f.cpuLoadPct),
      ].join(","),
    );
  }
  return lines.join("\n") + "\n";
}

export function serializePresentMonV2Csv(frames: readonly FrameSample[]): string {
  const lines = [
    "Application,ProcessID,CPUStartTime,FrameTime,CPUBusy,GPUBusy,GPUUtilization,GPUFrequency,GPUPower,GPUMemUsed",
  ];
  for (const f of frames) {
    lines.push(
      [
        "game.exe",
        "1234",
        String(f.timeMs / 1000),
        String(f.frameTimeMs),
        cell(f.cpuBusyMs),
        cell(f.gpuBusyMs),
        cell(f.gpuLoadPct),
        cell(f.gpuClockMhz),
        cell(f.gpuPowerW),
        cell(f.vramUsedMb),
      ].join(","),
    );
  }
  return lines.join("\n") + "\n";
}

export function serializeMangoHudLog(frames: readonly FrameSample[]): string {
  const lines = [
    "os,cpu,gpu,ram,kernel,driver,cpuscheduler",
    "Arch Linux,AMD Ryzen 7 7800X3D,NVIDIA GeForce RTX 4070,32768,6.9.1,NVIDIA 555.58.02,acpi-cpufreq",
    "fps,frametime,cpu_load,gpu_load,gpu_core_clock,gpu_vram_used,gpu_power,elapsed",
  ];
  for (const f of frames) {
    lines.push(
      [
        String(1000 / f.frameTimeMs),
        String(f.frameTimeMs),
        cell(f.cpuLoadPct),
        cell(f.gpuLoadPct),
        cell(f.gpuClockMhz),
        cell(f.vramUsedMb === undefined ? undefined : f.vramUsedMb / 1024),
        cell(f.gpuPowerW),
        String(f.timeMs * 1e6),
      ].join(","),
    );
  }
  return lines.join("\n") + "\n";
}
