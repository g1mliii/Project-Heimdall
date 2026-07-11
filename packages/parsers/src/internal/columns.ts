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

/** Optional per-frame sensor fields shared by the sources (§7.3). */
export const SENSOR_COLUMN_FIELDS = [
  "gpuLoadPct",
  "gpuClockMhz",
  "gpuPowerW",
  "vramUsedMb",
  "cpuLoadPct",
  "cpuBusyMs",
  "gpuBusyMs",
] as const;

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

/** PresentMon 2.x — detected via FrameTime; telemetry columns are opt-in. */
export const PRESENTMON_V2_COLUMNS: SourceColumns = {
  frameTimeMs: ["frametime"],
  timeSeconds: ["cpustarttime", "timeinseconds"],
  sensors: {
    cpuBusyMs: ["cpubusy"],
    gpuBusyMs: ["gpubusy"],
    gpuLoadPct: ["gpuutilization"],
    gpuClockMhz: ["gpufrequency"],
    gpuPowerW: ["gpupower"],
    vramUsedMb: ["gpumemused"],
  },
};

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
