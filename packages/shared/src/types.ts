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

import type { RunVisibility, RunStatus } from "./visibility";

export type { RunVisibility, RunStatus } from "./visibility";

/** Where a run's frame-time data came from. */
export type CaptureSource = "presentmon" | "mangohud" | "capframex";

/** Frame-generation technology a run used, if any (§2.3). */
export type GeneratedFrameTech = "none" | "dlss3" | "fsr3" | "xess";

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
}

/** Severity of an auto-diagnostic, matching the `Diagnostic` UI primitive. */
export type DiagnosticSeverity = "good" | "warn" | "bad" | "info";

/** A single auto-diagnostic result produced by the rules engine (Phase 6). */
export interface Diagnostic {
  id: string;
  /** Stable rule identifier, e.g. "vram-saturation-stutter". */
  code: string;
  severity: DiagnosticSeverity;
  /** Bold one-line headline (the warning name). */
  title: string;
  /** Plain-English explanation/advice. */
  detail: string;
  /** Sensors the rule consumed; the rule no-ops when any are absent (§15.5). */
  requiredSensors?: string[];
}

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
