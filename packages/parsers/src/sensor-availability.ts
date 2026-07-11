/**
 * Sensor-availability matrix (§7.3 spike). Which secondary sensors a
 * source×vendor combination reliably reports, so Phase 6 diagnostics and
 * Phase 7 physics checks can degrade gracefully instead of misfiring:
 *
 * - `detectAvailableSensors(frames)` is the per-run truth used to gate rules;
 * - `expectedSensors(source, vendor)` phrases degradation messages ("CapFrameX
 *   on NVIDIA usually reports GPU power — this file doesn't").
 *
 * Every cell is currently `provenance: "synthetic"`: seeded from documented
 * CapFrameX / PresentMon / MangoHud behavior, NOT yet confirmed against real
 * vendor exports. fixtures/README.md carries the wanted-list; when a real
 * export lands, its cell flips to `verified-real` in the same PR.
 */

import type { CaptureSource, FrameSample, GpuVendor } from "@heimdall/shared";

import { SENSOR_COLUMN_FIELDS, type SensorColumnField } from "./internal/columns";

export type SensorField = SensorColumnField;
export const SENSOR_FIELDS = SENSOR_COLUMN_FIELDS;

export type SensorAvailability = "expected" | "sometimes" | "never";

export interface SensorMatrixCell {
  availability: Record<SensorField, SensorAvailability>;
  /** Whether a real vendor export has confirmed this cell. */
  provenance: "synthetic" | "verified-real";
  note?: string;
}

function cell(
  availability: Record<SensorField, SensorAvailability>,
  note?: string,
): SensorMatrixCell {
  return note === undefined
    ? { availability, provenance: "synthetic" }
    : { availability, provenance: "synthetic", note };
}

/** CapFrameX logs sensors via its own HWInfo-backed pipeline on all vendors. */
const CAPFRAMEX_COMMON: Record<SensorField, SensorAvailability> = {
  gpuLoadPct: "expected",
  gpuClockMhz: "expected",
  gpuPowerW: "expected",
  vramUsedMb: "expected",
  cpuLoadPct: "expected",
  cpuBusyMs: "never",
  gpuBusyMs: "sometimes", // MsGPUActive exists on recent versions only
};

/** Bare PresentMon: busy times are v2-only, telemetry is opt-in. */
const PRESENTMON_COMMON: Record<SensorField, SensorAvailability> = {
  gpuLoadPct: "sometimes",
  gpuClockMhz: "sometimes",
  gpuPowerW: "sometimes",
  vramUsedMb: "sometimes",
  cpuLoadPct: "never",
  cpuBusyMs: "sometimes",
  gpuBusyMs: "sometimes",
};

/** MangoHud reports the full overlay sensor set on Linux for all vendors. */
const MANGOHUD_COMMON: Record<SensorField, SensorAvailability> = {
  gpuLoadPct: "expected",
  gpuClockMhz: "expected",
  gpuPowerW: "expected",
  vramUsedMb: "expected",
  cpuLoadPct: "expected",
  cpuBusyMs: "never",
  gpuBusyMs: "never",
};

export const SENSOR_AVAILABILITY: Record<
  CaptureSource,
  Partial<Record<GpuVendor, SensorMatrixCell>>
> = {
  capframex: {
    nvidia: cell(CAPFRAMEX_COMMON),
    amd: cell(
      { ...CAPFRAMEX_COMMON, gpuPowerW: "sometimes" },
      "AMD board power depends on driver/telemetry version",
    ),
    intel: cell(
      { ...CAPFRAMEX_COMMON, gpuPowerW: "sometimes", gpuClockMhz: "sometimes" },
      "Arc telemetry coverage varies by driver",
    ),
  },
  presentmon: {
    nvidia: cell(PRESENTMON_COMMON),
    amd: cell(PRESENTMON_COMMON),
    intel: cell(
      { ...PRESENTMON_COMMON, gpuPowerW: "expected" },
      "PresentMon is Intel's own tool; Arc telemetry is first-class when enabled",
    ),
  },
  mangohud: {
    nvidia: cell(MANGOHUD_COMMON, "NVML path"),
    amd: cell(MANGOHUD_COMMON, "sysfs/amdgpu path"),
    intel: cell(
      { ...MANGOHUD_COMMON, gpuPowerW: "sometimes" },
      "i915/xe power reporting varies by kernel",
    ),
  },
};

/** Sensors this source×vendor combination is *expected* to report (§7.3). */
export function expectedSensors(source: CaptureSource, vendor: GpuVendor): SensorField[] {
  const availability = SENSOR_AVAILABILITY[source][vendor]?.availability;
  if (availability === undefined) return [];
  return SENSOR_FIELDS.filter((field) => availability[field] === "expected");
}

/** Per-run truth: sensors that at least one frame actually carries. */
export function detectAvailableSensors(frames: readonly FrameSample[]): SensorField[] {
  return SENSOR_FIELDS.filter((field) => frames.some((frame) => frame[field] !== undefined));
}
