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
  /** Capture-relative timestamp in seconds (converted to ms by the parser). */
  timeSeconds: readonly string[];
  /** Optional sensor columns; absent ones become a `missing-sensors` warning. */
  sensors: Partial<Record<SensorColumnField, readonly string[]>>;
  /**
   * Sensors this source POLLS on a timer rather than measuring per present
   * (§16a.3). Being in a row does not make a reading frame-aligned: a value
   * sampled every ~100–250 ms is simply repeated across whatever frames fall in
   * that window, so it describes an interval, not the frame it sits beside.
   *
   * This matters because per-frame rules refuse polled data — `cpu-bottleneck`
   * checks `frameAligned` before it will fire, precisely so a smoothed
   * utilization average cannot be read as evidence about an individual frame.
   * Listing a field here is what makes that refusal work.
   */
  periodicSensors?: readonly SensorColumnField[];
}

/**
 * Per-source alignment verdict for every sensor column the source can carry.
 *
 * Row-based columns are frame-aligned by default — they are measured for the
 * present they sit on — EXCEPT the ones the source declares as polled.
 */
export function frameAlignedSensorMap(
  columns: SourceColumns,
): Partial<Record<SensorColumnField, boolean>> {
  const periodic = new Set<string>(columns.periodicSensors ?? []);
  return Object.fromEntries(
    Object.keys(columns.sensors).map((field) => [field, !periodic.has(field)]),
  );
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

/** PresentMon 2.x `--v1_metrics` compatibility output. */
export const PRESENTMON_V1_COMPAT_COLUMNS: SourceColumns = {
  ...PRESENTMON_V1_COLUMNS,
  sensors: {
    ...PRESENTMON_V1_COLUMNS.sensors,
    gpuBusyMs: ["msgpuactive"],
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
  // CPUStartTime is already milliseconds and is selected explicitly by the
  // PresentMon parser. TimeInSeconds remains the fallback for other v2 builds.
  timeSeconds: ["timeinseconds"],
  sensors: {
    cpuBusyMs: ["cpubusy", "mscpubusy"],
    gpuBusyMs: ["gpubusy", "msgpubusy"],
    // `heimdall*` aliases are supplied by the Heimdall desktop client, which
    // samples Windows GPU performance counters alongside the capture (§22.2).
    // They are deliberately NOT spelled like PresentMon's own columns: the
    // console application emits no GPU telemetry at all (confirmed against
    // 2.4.1/2.5.1 and Intel's console-app README), so a `GPUUtilization` column
    // in a file labelled PresentMon would misattribute our data to their tool.
    gpuLoadPct: ["gpuutilization", "gpu%", "gpuusage", "heimdallgpuutilization"],
    gpuClockMhz: ["gpufrequency", "gpuclock"],
    gpuPowerW: ["gpupower"],
    vramUsedMb: ["gpumemused", "gpumemusage", "heimdallgpumemusedmb"],
  },
  // Every one of these is a polled sensor, whichever tool wrote it: PresentMon's
  // own telemetry comes from its service on a timer, and the Heimdall client
  // samples PDH counters on a timer. Only the busy/time columns above are
  // measured per present.
  periodicSensors: ["gpuLoadPct", "gpuClockMhz", "gpuPowerW", "vramUsedMb"],
};

/**
 * Pinned PresentMon capture profiles (§16a.2). We recognize exactly these
 * tested generations rather than inferring a generic-version compatibility: the
 * CSV can reveal the runtime/API and (v2+) presentation semantics, but the tool
 * version and HAGS state must be DECLARED by the desktop client (Phase 9), so
 * they live in the methodology manifest, not here.
 */
export const PRESENTMON_PROFILES = {
  v1: {
    id: "presentmon-1.x",
    detect: "MsBetweenPresents",
    hasBusyTimes: false,
    hasPresentationSemantics: false,
  },
  v1MetricsCompat: {
    id: "presentmon-2.x-v1-metrics",
    detect: "MsBetweenPresents + msGPUActive",
    hasBusyTimes: true,
    hasPresentationSemantics: true,
  },
  v2: {
    id: "presentmon-2.x",
    detect: "FrameTime",
    hasBusyTimes: true,
    hasPresentationSemantics: true,
  },
} as const;

/**
 * Header columns that expose PresentMon capture *semantics* (not per-frame
 * metrics): the graphics runtime, the swapchain present mode, and tearing/sync
 * state. Pre-lowercased to match `buildHeaderMap`.
 */
export const PRESENTMON_SEMANTICS_COLUMNS = {
  runtime: ["runtime", "presentruntime"],
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
