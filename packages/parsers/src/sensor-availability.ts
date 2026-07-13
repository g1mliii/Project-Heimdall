/**
 * Sensor-availability matrix (§7.3 spike). Which secondary sensors a
 * source×vendor combination reliably reports, so Phase 6 diagnostics and
 * Phase 7 physics checks can degrade gracefully instead of misfiring:
 *
 * - `detectAvailableSensors(frames)` is the per-run truth used to gate rules;
 * - `expectedSensors(source, vendor)` phrases degradation messages ("CapFrameX
 *   on NVIDIA usually reports GPU power — this file doesn't").
 *
 * Every cell is seeded `provenance: "synthetic"` from documented CapFrameX /
 * PresentMon / MangoHud behavior. When a real vendor export lands in fixtures/,
 * its cell flips to `verified-real` via {@link verifiedCell} in the SAME PR,
 * carrying structured evidence (driver, tool version, headers, units, per-field
 * frame-alignment, and the proving fixture path). The flip-honesty test fails
 * if a `verified-real` cell has no matching golden fixture on disk, so
 * provenance can never outrun the data. See fixtures/README.md for the
 * canonical flip procedure and wanted-list.
 */

import {
  CAPABILITY_MANIFEST_VERSION,
  type CaptureCapability,
  type CapabilityManifest,
  type CaptureSource,
  type FrameSample,
  type GpuVendor,
  type HardwareSnapshot,
  type PresentationMode,
  type SyncMode,
  type VramCapacity,
} from "@heimdall/shared";

import { SENSOR_COLUMN_FIELDS, type SensorColumnField } from "./internal/columns";

export type SensorField = SensorColumnField;
export const SENSOR_FIELDS = SENSOR_COLUMN_FIELDS;

export type SensorAvailability = "expected" | "sometimes" | "never";

/**
 * Structured evidence backing a `verified-real` cell (16a.1). A cell may only
 * claim `verified-real` when a real, anonymized vendor export was landed in
 * `fixtures/` in the same PR — `fixture` names that golden file, and the
 * flip-honesty test (`sensor-availability.test.ts`) fails if it is missing from
 * disk. `synthetic` cells carry no evidence.
 */
export interface SensorMatrixCellEvidence {
  source: CaptureSource;
  gpuVendor: GpuVendor;
  /** GPU driver version the confirming export was captured on. */
  driver: string;
  /** Capture-tool version string (e.g. "CapFrameX 1.7.3", "PresentMon 2.3.0"). */
  toolVersion: string;
  /** Verbatim sensor header names observed in the confirming export. */
  headers: readonly string[];
  /** Documented/observed unit per confirmed sensor field. */
  units: Partial<Record<SensorField, string>>;
  /** Whether each confirmed field is sampled per-frame (vs periodically). */
  frameAligned: Partial<Record<SensorField, boolean>>;
  /** Repo-relative fixture path (under `fixtures/`) that proves this cell. */
  fixture: string;
}

export interface SensorMatrixCell {
  availability: Record<SensorField, SensorAvailability>;
  /** Whether a real vendor export has confirmed this cell. */
  provenance: "synthetic" | "verified-real";
  /** Present only when `provenance === "verified-real"` (16a.1). */
  evidence?: SensorMatrixCellEvidence;
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

/**
 * Construct a `verified-real` cell from a real export's structured evidence
 * (16a.1). The `fixture` in `evidence` MUST exist on disk with its
 * `.expected.json` — enforced by the flip-honesty test — so provenance can
 * never outrun the data. Cells flip one PR at a time as real exports arrive.
 */
export function verifiedCell(
  availability: Record<SensorField, SensorAvailability>,
  evidence: SensorMatrixCellEvidence,
  note?: string,
): SensorMatrixCell {
  return note === undefined
    ? { availability, provenance: "verified-real", evidence }
    : { availability, provenance: "verified-real", evidence, note };
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

/**
 * The GPU-execution timing columns whose values are affected by Hardware-
 * Accelerated GPU Scheduling. Their presence attaches an advisory caveat to the
 * manifest — GPUBusy/MsGPUActive are useful signals but must NEVER be promoted
 * to a hard integrity flag (regression invariant).
 */
const HAGS_AFFECTED_FIELDS: readonly SensorField[] = ["gpuBusyMs"];

/**
 * Derive the explicit VRAM-capacity state (§16a.4) from a hardware snapshot.
 * A bare `undefined` total is reported as `{ state: "unknown" }` so downstream
 * rules can tell "parser didn't look" from a real capacity. Unified-memory is
 * declared upstream (Phase 13 macOS), never inferred from frames.
 */
export function deriveVramCapacity(hardware?: HardwareSnapshot): VramCapacity {
  const totalMb = hardware?.gpuVramTotalMb;
  return totalMb !== undefined && Number.isFinite(totalMb) && totalMb > 0
    ? { totalMb }
    : { state: "unknown" };
}

/**
 * Derive the per-run {@link CapabilityManifest} (§16a.3/§16a.4) purely from the
 * parsed frames + hardware snapshot, so the browser and the server recompute it
 * identically. Capture semantics the merged frame stream cannot reveal
 * (presentation/sync mode) default to `"unknown"` and are populated by the
 * uploader/desktop client; VRAM capacity and frame-generation are detectable
 * here. This never inspects per-frame values beyond presence, so it stays cheap
 * over 500k-frame captures.
 */
/**
 * Capture semantics that the merged frame stream cannot reveal (§16a.3) —
 * declared by the uploader/desktop client or detected from source-specific
 * header columns (e.g. PresentMon `PresentMode`/`AllowsTearing`). Carried
 * through the canonical recompute unchanged, since the worker never sees the
 * original headers.
 */
export interface DeclaredCaptureSemantics {
  presentationMode?: PresentationMode;
  syncMode?: SyncMode;
}

export function deriveCapabilityManifest(
  frames: readonly FrameSample[],
  source: CaptureSource,
  hardware?: HardwareSnapshot,
  declared?: DeclaredCaptureSemantics,
): CapabilityManifest {
  return buildCapabilityManifest({
    source,
    presentSensors: detectAvailableSensors(frames),
    frameGenerationObserved: frames.some((frame) => frame.generated === true),
    hardware,
    declared,
  });
}

/**
 * Construct a {@link CapabilityManifest} from already-detected sensor presence
 * — the shape the verification worker uses, which knows which sensor columns
 * carried a value during its single columnar Parquet pass but never
 * materializes a `FrameSample[]`. `deriveCapabilityManifest` is the frame-array
 * convenience over this; both must produce identical manifests for identical
 * evidence (browser ↔ server recompute parity).
 */
export function buildCapabilityManifest(input: {
  source: CaptureSource;
  presentSensors: Iterable<SensorField>;
  frameGenerationObserved: boolean;
  hardware?: HardwareSnapshot;
  /** Declared/detected capture semantics preserved across the recompute. */
  declared?: DeclaredCaptureSemantics;
}): CapabilityManifest {
  const { source, frameGenerationObserved, hardware, declared } = input;
  const present = new Set(input.presentSensors);
  const sensors = Object.fromEntries(
    SENSOR_FIELDS.map((field): [SensorField, CaptureCapability] => {
      const isPresent = present.has(field);
      // CSV/JSON row-per-frame sources are frame-aligned by construction; a
      // periodically-sampled real export flips this via the matrix-cell
      // evidence, not the derive path.
      return [field, { present: isPresent, frameAligned: isPresent }];
    }),
  ) as CapabilityManifest["sensors"];

  const caveats: string[] = [];
  if (HAGS_AFFECTED_FIELDS.some((field) => present.has(field))) {
    caveats.push(
      "GPU-execution timing (GPUBusy/MsGPUActive) is affected by Hardware-Accelerated GPU " +
        "Scheduling (HAGS) and is used only as a likelihood signal, never as a hard integrity flag.",
    );
  }

  return {
    version: CAPABILITY_MANIFEST_VERSION,
    source,
    sensors,
    presentationMode: declared?.presentationMode ?? "unknown",
    syncMode: declared?.syncMode ?? "unknown",
    frameGenerationObserved,
    vramCapacity: deriveVramCapacity(hardware),
    caveats,
  };
}
