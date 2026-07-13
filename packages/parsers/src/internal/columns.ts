/**
 * Column-alias tables (§7.1–§8): one alias list per `FrameSample` field per
 * source, matched case-insensitively against the header row. Column reordering
 * is free (lookup is by name), and a vendor/version rename is a one-line alias
 * addition here. All aliases are pre-lowercased to match `buildHeaderMap`.
 *
 * Alias provenance is synthetic-documented (fixtures/README.md): seeded from
 * the published CapFrameX / PresentMon / MangoHud column layouts, to be
 * confirmed against real exports as they land.
 */

import { CAPABILITY_SENSOR_FIELDS } from "@heimdall/shared";

/**
 * Optional per-frame sensor fields shared by the sources (§7.3). Re-exports the
 * canonical set from `@heimdall/shared` so the parser column tables, the
 * sensor-availability matrix, and the capability manifest cannot drift apart.
 */
export const SENSOR_COLUMN_FIELDS = CAPABILITY_SENSOR_FIELDS;

export type SensorColumnField = (typeof SENSOR_COLUMN_FIELDS)[number];

export interface SourceColumns {
  /** Required frame-time column — a header without it is `missing-columns`. */
  frameTimeMs: readonly string[];
  /** Capture-relative timestamp in SECONDS (converted to ms by the parser). */
  timeSeconds: readonly string[];
  /** Optional sensor columns; absent ones become a `missing-sensors` warning. */
  sensors: Partial<Record<SensorColumnField, readonly string[]>>;
}

export const CAPFRAMEX_COLUMNS: SourceColumns = {
  frameTimeMs: ["msbetweenpresents"],
  timeSeconds: ["timeinseconds"],
  sensors: {
    gpuLoadPct: ["gpuusage", "gpuusage (%)", "gpu usage (%)"],
    gpuClockMhz: ["gpuclock", "gpuclock (mhz)", "gpu clock (mhz)"],
    gpuPowerW: ["gpupower", "gpupower (w)", "gpu power (w)"],
    vramUsedMb: ["gpumemusage", "gpumemusage (mb)", "vram usage (mb)", "gpumem dedicated usage (mb)"],
    cpuLoadPct: ["cpuusage", "cpuusage (%)", "cpu usage (%)"],
    gpuBusyMs: ["msgpuactive"],
  },
};

/** PresentMon 1.x — detected via MsBetweenPresents + TimeInSeconds. */
export const PRESENTMON_V1_COLUMNS: SourceColumns = {
  frameTimeMs: ["msbetweenpresents"],
  timeSeconds: ["timeinseconds"],
  sensors: {
    // v1 has no busy-time or telemetry columns; sensors are all absent.
  },
};

/**
 * PresentMon 2.x — detected via FrameTime; telemetry columns are opt-in. Busy-
 * time aliases cover the current `CPUBusy`/`GPUBusy` names AND the intermediate
 * `MsCPUBusy`/`MsGPUBusy` variants some 2.x builds emitted, so a tested profile
 * is pinned rather than a generic version guess (§16a.2).
 */
export const PRESENTMON_V2_COLUMNS: SourceColumns = {
  frameTimeMs: ["frametime"],
  timeSeconds: ["cpustarttime", "timeinseconds"],
  sensors: {
    cpuBusyMs: ["cpubusy", "mscpubusy"],
    gpuBusyMs: ["gpubusy", "msgpubusy"],
    gpuLoadPct: ["gpuutilization", "gpu%", "gpuusage"],
    gpuClockMhz: ["gpufrequency", "gpuclock"],
    gpuPowerW: ["gpupower"],
    vramUsedMb: ["gpumemused", "gpumemusage"],
  },
};

/**
 * Pinned PresentMon capture profiles (§16a.2). We recognize exactly these
 * tested generations rather than inferring a generic-version compatibility: the
 * CSV can reveal the runtime/API and (v2+) presentation semantics, but the tool
 * version and HAGS state must be DECLARED by the desktop client (Phase 9), so
 * they live in the methodology manifest, not here.
 */
export const PRESENTMON_PROFILES = [
  {
    id: "presentmon-1.x",
    detect: "MsBetweenPresents",
    hasBusyTimes: false,
    hasPresentationSemantics: false,
  },
  {
    id: "presentmon-2.x",
    detect: "FrameTime",
    hasBusyTimes: true,
    hasPresentationSemantics: true,
  },
] as const;

/**
 * Header columns that expose PresentMon capture *semantics* (not per-frame
 * metrics): the graphics runtime, the swapchain present mode, and tearing/sync
 * state. Pre-lowercased to match `buildHeaderMap`.
 */
export const PRESENTMON_SEMANTICS_COLUMNS = {
  runtime: ["runtime"],
  presentMode: ["presentmode"],
  allowsTearing: ["allowstearing"],
  syncInterval: ["syncinterval"],
} as const;

/**
 * MangoHud log rows. `frametime` is already ms; the row timestamp comes from
 * `elapsed` (nanoseconds — the parser divides by 1e6), not a seconds column.
 */
export const MANGOHUD_COLUMNS: SourceColumns = {
  frameTimeMs: ["frametime"],
  timeSeconds: [],
  sensors: {
    gpuLoadPct: ["gpu_load"],
    gpuClockMhz: ["gpu_core_clock"],
    gpuPowerW: ["gpu_power"],
    vramUsedMb: ["gpu_vram_used"],
    cpuLoadPct: ["cpu_load"],
  },
};
