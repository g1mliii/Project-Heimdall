/**
 * Cross-app domain model (IMPLEMENTATION_PLAN §2.1).
 *
 * Hand-authored canonical TypeScript types for the whole product. Wire/ingest
 * DTOs and their validation live in `schemas.ts`; where a DTO maps 1:1 to a type
 * here, a compile-time drift guard in the tests keeps the two from diverging.
 *
 * Visibility/status are the load-bearing privacy primitives — re-exported from
 * `visibility.ts`, never redefined here.
 */

import type { CapabilitySensorField } from "./constants";
import type { RunVisibility, RunStatus } from "./visibility";

export type { RunVisibility, RunStatus } from "./visibility";

/** Where a run's frame-time data came from. */
export type CaptureSource = "presentmon" | "mangohud" | "capframex";

/** Frame-generation technology a run used, if any (§2.3). */
export type GeneratedFrameTech = "none" | "unknown" | "dlss3" | "fsr3" | "xess";

/** GPU silicon vendor, inferred from the captured hardware string. */
export type GpuVendor = "nvidia" | "amd" | "intel" | "unknown";

/** Confidence in a percentile estimate, driven by sample count (§9.2). */
export type ConfidenceLevel = "high" | "medium" | "low";

/**
 * Hardware + software the run was captured on. Raw display strings are quasi-
 * identifying (docs/integrity-and-privacy.md §5); canonical ids are resolved
 * server-side on finalize (§11.9) and are optional before that.
 */
export interface HardwareSnapshot {
  /** Raw GPU display string as captured (e.g. "NVIDIA GeForce RTX 4070"). */
  gpu: string;
  /** Raw CPU display string as captured. */
  cpu: string;
  /** Silicon vendor parsed from `gpu`. */
  gpuVendor?: GpuVendor;
  /** Installed system memory in gigabytes. */
  ramGb?: number;
  /** Configured RAM speed in MT/s. */
  ramSpeedMtps?: number;
  /** Rated (SPD/XMP) RAM speed in MT/s — drives the RAM-below-rated rule (§15.3). */
  ramRatedSpeedMtps?: number;
  /** Operating system string. */
  os?: string;
  /** GPU driver version string. */
  gpuDriver?: string;
  /** Total dedicated VRAM in MB, best-effort from the source — drives §15.1. */
  gpuVramTotalMb?: number;
  /** Capture resolution, e.g. "2560x1440". */
  resolution?: string;
  /** Canonical GPU id (PCI device/subsystem-derived) once resolved (§4.4). */
  canonicalGpuId?: string;
  /** Canonical CPU id once resolved (§4.4). */
  canonicalCpuId?: string;
}

/**
 * A single captured frame. Per-frame data lives in Parquet on R2, never in
 * Postgres — this type is the in-memory/parse shape (§invariants). Secondary
 * sensor fields are optional: not every source/vendor reports them (§7.3).
 */
export interface FrameSample {
  /** Milliseconds since capture start. */
  timeMs: number;
  /** Frame time in milliseconds. */
  frameTimeMs: number;
  /** True when this frame was generated (DLSS3/FSR3/XeSS) rather than app-rendered. */
  generated?: boolean;
  /** GPU utilization percent (0–100). */
  gpuLoadPct?: number;
  /** GPU core clock in MHz. */
  gpuClockMhz?: number;
  /** GPU board power draw in watts. */
  gpuPowerW?: number;
  /** VRAM in use in megabytes. */
  vramUsedMb?: number;
  /** CPU utilization percent (0–100). */
  cpuLoadPct?: number;
  /** PresentMon 2.x CPUBusy — ms the CPU spent producing the frame (§7 spike). */
  cpuBusyMs?: number;
  /** PresentMon 2.x GPUBusy / CapFrameX MsGPUActive — ms of GPU work for the frame. */
  gpuBusyMs?: number;
}

/**
 * Explicit VRAM-capacity state (§16a.4). Replaces the ambiguous bare
 * `gpuVramTotalMb === undefined`, which could not tell "the parser never looked"
 * from "this GPU has no dedicated VRAM." `unified-memory` also unblocks the
 * Phase 13 macOS path where CPU/GPU share one pool.
 */
export type VramCapacity =
  | { totalMb: number }
  | { state: "unified-memory" | "unknown" };

/**
 * How a run's frames reached the display (§16a.3). Bare CSV captures can't
 * always reveal this, so `unknown` is a first-class value; the desktop client
 * (Phase 9) and PresentMon's `PresentMode` column populate it when they can.
 */
export type PresentationMode =
  | "hardware-independent-flip"
  | "hardware-composed-flip"
  | "composed"
  | "legacy"
  | "unknown";

/** Frame-pacing/sync semantics recorded per run (§16a.3). */
export type SyncMode = "vsync" | "tearing" | "vrr" | "unknown";

/** Per-sensor presence + frame-alignment for one run. */
export interface CaptureCapability {
  /** True when at least one frame carried this sensor. */
  present: boolean;
  /**
   * True when the present values are sampled per-frame (CSV row-per-frame),
   * false when they are periodically sampled (e.g. 250 ms telemetry polls) and
   * therefore not safe to correlate against a single frame's timing.
   */
  frameAligned: boolean;
}

/**
 * Versioned per-run capability manifest (§16a.3/§16a.4): which sensors this run
 * actually carries and whether they are frame-aligned, its capture semantics,
 * an explicit VRAM-capacity state, and any source caveats. Derived purely at
 * parse (`deriveCapabilityManifest`) so the browser and the server recompute it
 * identically, then persisted as derived rollup metadata in Postgres — never
 * per-frame. Everything downstream (confidence-graded findings, Phase 7
 * comparability) reads from here rather than re-sniffing frames.
 */
export interface CapabilityManifest {
  /** The {@link CAPABILITY_MANIFEST_VERSION} this manifest was derived under. */
  version: number;
  source: CaptureSource;
  /** Per-sensor presence + frame-alignment, keyed by the 7-field sensor set. */
  sensors: Record<CapabilitySensorField, CaptureCapability>;
  presentationMode: PresentationMode;
  syncMode: SyncMode;
  /** True when the capture marked any frame as engine-generated (DLSS3/FSR3/XeSS). */
  frameGenerationObserved: boolean;
  vramCapacity: VramCapacity;
  /**
   * Human-readable source caveats (e.g. "GPU-execution timing is HAGS-affected
   * and must never be a hard integrity flag"). Advisory only — never gating.
   */
  caveats: string[];
}

/**
 * The precomputed run summary — Postgres-resident, canonical once the server
 * recompute validates it (§11.5). Mirrors what `metrics.ts` produces in Phase 3.
 */
export interface RunSummary {
  /** Average FPS across the capture. */
  avgFps: number;
  /** 1% low FPS (mean of the slowest 1% of frames, as FPS). */
  onePercentLowFps: number;
  /** 0.1% low FPS. */
  pointOnePercentLowFps: number;
  /** Median frame time (ms). */
  frameTimeP50Ms: number;
  /** 95th-percentile frame time (ms). */
  frameTimeP95Ms: number;
  /** 99th-percentile frame time (ms). */
  frameTimeP99Ms: number;
  /** Number of detected stutter events. */
  stutterCount: number;
  /** Fraction of frames that were generated (0–1). */
  generatedFramePct: number;
  /** Confidence in the 0.1% low, by sample count (§9.2). */
  pointOnePercentLowConfidence: ConfidenceLevel;
  /** Total frames analyzed. */
  sampleCount: number;
  /** Capture duration in seconds. */
  durationSeconds: number;
}

/**
 * How a capture was produced (§17.5). A `benchmark-scene` is a repeatable
 * built-in benchmark or fixed route; `gameplay` is a hand-played session;
 * `freeform` is everything else and stays separately filterable so it never
 * pools with methodical runs.
 */
export type SceneType = "benchmark-scene" | "gameplay" | "freeform";

/** Upscaler family in use (§16c.1). */
export type UpscalerMode = "none" | "dlss" | "fsr" | "xess" | "unknown";

/** Ray-tracing state (§16c.1). */
export type RayTracingMode = "off" | "on" | "unknown";

/** Hardware-Accelerated GPU Scheduling state, when the capture environment declares it. */
export type HagsState = "enabled" | "disabled" | "unknown";

/** Frame-pacing / sync ceiling that shapes comparability (§16c.1/§16c.3). */
export interface FramePacing {
  /** Applied FPS cap, if any. */
  capFps?: number;
  vsync: boolean;
  vrr: boolean;
  /** Display refresh rate in Hz, when known. */
  refreshHz?: number;
}

/**
 * Reproducible methodology manifest (§16c.1). Records HOW a run was captured so
 * Phase 7 only pools comparable runs. Quasi-identifying, so it inherits the
 * hardware-snapshot privacy/deletion rules (stored on `runs`, cascaded via the
 * run FK). Mostly *declared* by the uploader/desktop client; the parser fills
 * what it can detect (resolution, presentation mode, frame-gen).
 */
export interface MethodologyManifest {
  /** The {@link METHODOLOGY_MANIFEST_VERSION} this manifest was declared under. */
  version: number;
  /** Game build/patch string (e.g. "2.1"). */
  gameBuild?: string;
  /** Scene/route name within the game. */
  scene?: string;
  sceneType: SceneType;
  /** Graphics-settings preset name (e.g. "Ultra"). */
  settingsPreset?: string;
  /** Graphics API (e.g. "dx12", "vulkan"). */
  graphicsApi?: string;
  /** Capture resolution, e.g. "2560x1440". */
  resolution?: string;
  upscaler: UpscalerMode;
  rayTracing: RayTracingMode;
  frameGeneration: GeneratedFrameTech;
  framePacing: FramePacing;
  /** Operating system string. */
  os?: string;
  /** GPU driver version string. */
  gpuDriver?: string;
  /** Capture tool + version, e.g. "PresentMon 2.3.0". */
  captureTool?: string;
  /** Pinned capture profile id (e.g. "presentmon-2.x"). */
  captureProfile?: string;
  /** HAGS changes GPU execution timing semantics; unknown is explicitly allowed. */
  hags?: HagsState;
  /** Warm-up policy applied before the measured window. */
  warmupPolicy?: string;
  /** Measured capture duration in seconds. */
  captureDurationSeconds?: number;
}

/**
 * A benchmark run: metadata + precomputed summary. Per-frame samples are NOT
 * inlined — `framesObjectKey` points at the Parquet blob in R2.
 */
export interface Run {
  id: string;
  /** Raw game title as submitted (canonicalized to a game id server-side). */
  game: string;
  captureSource: CaptureSource;
  visibility: RunVisibility;
  status: RunStatus;
  hardware: HardwareSnapshot;
  summary: RunSummary;
  generatedFrameTech: GeneratedFrameTech;
  /**
   * Auto-diagnostic findings from the Phase 6 rules engine — written by the
   * verification worker, empty until (and unless) a rule fires.
   */
  diagnostics: Diagnostic[];
  /** Ingest schema version, so old uploads reprocess safely (§2.2). */
  schemaVersion: number;
  /** Parser version that produced the summary, for the same reason. */
  parserVersion: string;
  /** ISO-8601 creation timestamp. */
  createdAt: string;
  /** R2 object key for the per-frame Parquet, if uploaded. */
  framesObjectKey?: string;
  /** Owner account id; absent for anonymous runs (accounts arrive Phase 8). */
  ownerId?: string;
  /** Whether an optional client signature verified (evidence, not gatekeeping §11.7). */
  signatureValid?: boolean;
  /**
   * Per-run capability manifest (§16a.3) — canonical once the verify worker
   * recomputes it. Optional so a source whose new evidence is absent behaves
   * exactly as it did in Phase 6 (regression invariant).
   */
  capabilityManifest?: CapabilityManifest;
  /**
   * Reproducible methodology manifest (§16c.1). Optional — declared at upload;
   * drives the Phase 7 comparability key. Quasi-identifying (privacy §5).
   */
  methodologyManifest?: MethodologyManifest;
  /**
   * Optional opaque repeatable-run group (§16c.2). Raw members remain
   * individually addressable; this only associates them for variance
   * calculations. New ids are random UUIDs; legacy display-label ids remain
   * readable during the migration but cannot be joined by new uploads.
   */
  benchmarkSetId?: string;
  /** True only for an intentionally retained warm-up pass (§16c.2). */
  isWarmup?: boolean;
}

/** Severity of an auto-diagnostic, matching the `Diagnostic` UI primitive. */
export type DiagnosticSeverity = "good" | "warn" | "bad" | "info";

/**
 * Concrete evidence a diagnostic fired on (§16b.2). Structured but permissive —
 * every field is optional so Phase 6 findings (which carry none) round-trip
 * unchanged, and richer Phase 6.5 findings record exactly what they measured so
 * a reader can see *why* the rule fired.
 */
export interface DiagnosticEvidence {
  /** Fraction of the capture (0–1) the finding's condition covered. */
  coverageFraction?: number;
  /** Sensor fields the finding relied on. */
  sensors?: CapabilitySensorField[];
  /** Named measured values (e.g. `{ cpuBoundFraction: 0.62 }`). */
  metrics?: Record<string, number>;
  /** Capture-semantics / source caveats that qualified the finding. */
  caveats?: string[];
  /** Curated source basis for time-sensitive driver findings (§16e.3). */
  provenance?: {
    sourceUrl?: string;
    /** Driver version the source cites: a catalog latest or a game-ready minimum. */
    referencedVersion?: string;
    /** When the source fact was retrieved, independent of its source kind. */
    fetchedAt?: string;
  };
}

/** A single auto-diagnostic result produced by the rules engine (Phase 6/6.5). */
export interface Diagnostic {
  id: string;
  /** Stable rule identifier, e.g. "vram-saturation-stutter". */
  code: string;
  severity: DiagnosticSeverity;
  /** Bold one-line headline (the warning name). */
  title: string;
  /** Plain-English explanation/advice. */
  detail: string;
  /** Concrete evidence the finding fired on (§16b.2); absent for Phase 6 rules. */
  evidence?: DiagnosticEvidence;
  /** Version of the rule that produced this finding (§16b.2). */
  ruleVersion?: string;
  /** Confidence label for likelihood-graded findings (§16b); absent = asserted. */
  confidence?: ConfidenceLevel;
  /** When this stored finding was last evaluated against its rule inputs. */
  evaluatedAt?: string;
}

/** A newly produced diagnostic before Postgres assigns its identity. */
export type DiagnosticFinding = Omit<Diagnostic, "id">;

/** A head-to-head comparison between two runs (Phase 10). */
export interface Comparison {
  id: string;
  baseRunId: string;
  againstRunId: string;
  /** Per-metric deltas (`against` minus `base`). */
  deltas: Partial<Record<keyof RunSummary, number>>;
  createdAt: string;
}

/** Lifecycle of a durable server-side verification job (§11.5). */
export type VerificationJobStatus = "pending" | "running" | "succeeded" | "failed";

/**
 * A DB-backed verification job. The worker recomputes the summary from the
 * stored Parquet; that recompute is canonical for public stats.
 */
export interface VerificationJob {
  id: string;
  runId: string;
  status: VerificationJobStatus;
  /** Number of times the worker has attempted this job. */
  attempts: number;
  /** When the row was locked by a worker (for idempotent claim/retry). */
  lockedAt?: string | null;
  createdAt: string;
  /** Canonical summary, once recomputed. */
  recomputedSummary?: RunSummary;
  /** Failure detail, when `status === "failed"`. */
  error?: string | null;
}
