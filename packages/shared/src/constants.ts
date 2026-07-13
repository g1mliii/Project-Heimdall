/**
 * Cross-app constants (IMPLEMENTATION_PLAN §2.3).
 *
 * Statistical outlier sigma/MAD thresholds already live in `integrity.ts` as the
 * single source of truth — re-exported here, never duplicated.
 */

import type { GeneratedFrameTech } from "./types";

/** Re-export the canonical outlier thresholds so callers get them from one place. */
export { OUTLIER } from "./integrity";

/** Default capture length suggested in the capture UI (seconds). */
export const DEFAULT_CAPTURE_SECONDS = 60;

/**
 * Frame-generation technologies recognized from telemetry flags (§2.3).
 * Keys/values match the `GeneratedFrameTech` domain type.
 */
export const GENERATED_FRAME_TECH = {
  none: "none",
  unknown: "unknown",
  dlss3: "dlss3",
  fsr3: "fsr3",
  xess: "xess",
} as const satisfies Record<GeneratedFrameTech, GeneratedFrameTech>;

/**
 * Frame-count thresholds that grade 0.1%-low confidence (§9.2). A 0.1% low needs
 * ~1000 frames before a single frame even represents 0.1%; below that it is noisy.
 */
export const POINT_ONE_PERCENT_LOW_CONFIDENCE_FRAMES = {
  /** At/above this many frames the 0.1% low is trustworthy. */
  high: 5000,
  /** At/above this, usable but flagged. Below it, low confidence. */
  medium: 1000,
} as const;

/**
 * Stutter detection (§9.1). A frame counts as a stutter only when BOTH
 * conditions hold, so high-fps micro-blips don't inflate the count.
 */
export const STUTTER = {
  /** Frame time must exceed this multiple of the run's median frame time. */
  medianMultiplier: 2.5,
  /** ...and this absolute floor in milliseconds. */
  minFrameTimeMs: 20,
} as const;

/**
 * Diagnostics rules-engine thresholds (§15). Single source of truth for the
 * four Phase 6 rules — the engine, its fixtures, and its tests all read these,
 * so a threshold is tuned in exactly one place. Stutter identification reuses
 * {@link STUTTER} / `stutterThresholdMs`; there is deliberately no second
 * stutter threshold here.
 */
export const DIAGNOSTICS = {
  /** VRAM is "saturated" at/above this fraction of total capacity (§15.1). */
  vramSaturationFraction: 0.95,
  /**
   * The VRAM-stutter rule fires only when at least this share of a run's
   * stutter frames land on saturated frames — a few coincidental spikes over a
   * VRAM peak are not evidence of a saturation problem.
   */
  vramStutterOverlapFraction: 0.5,
  /** CPU-bottleneck: a frame is CPU-bound at/above this CPU load (§15.2). */
  cpuBottleneckCpuPct: 95,
  /** ...and at/below this GPU load (the GPU is waiting on the CPU). */
  cpuBottleneckGpuPct: 70,
  /** A CPU finding needs at least this many paired CPU/GPU samples. */
  cpuBottleneckMinTelemetrySamples: 30,
  /** Paired CPU/GPU telemetry must cover this share of the capture. */
  cpuBottleneckMinTelemetryCoverageFraction: 0.5,
  /** ...and the rule fires only when that share of frames are CPU-bound. */
  cpuBottleneckMinAffectedFraction: 0.25,
  /**
   * Common FPS caps. A stable cadence at one of these values is ambiguous with
   * a deliberate limiter, so the CPU rule suppresses rather than guessing.
   */
  commonFrameCapFps: [30, 40, 45, 50, 60, 72, 75, 90, 100, 120, 144, 165, 180, 200, 240, 300, 360],
  /** Allowed relative drift from the nearest common frame-cap cadence. */
  frameCapToleranceFraction: 0.025,
  /** Share of real frame times that must hold the cap before suppressing. */
  frameCapMinStableFraction: 0.9,
  /** Curated game-ready driver requirements self-suppress after this age. */
  driverRequirementMaxAgeDays: 30,
  /**
   * RAM-below-rated: fire only when actual MT/s trails rated by more than this
   * fraction, so SPD/XMP rounding (e.g. 5600 vs 5601) never trips it (§15.3).
   */
  ramBelowRatedTolerancePct: 0.02,
} as const;

/** Fastest plausible frame cadence: 100,000 FPS. Rejects numerical abuse. */
export const MIN_FRAME_TIME_MS = 0.01;

/**
 * Current ingest schema version. Bump when the wire DTO changes incompatibly so
 * stored uploads can be reprocessed against the right shape (§2.2).
 */
export const CURRENT_SCHEMA_VERSION = 1;

/**
 * Placeholder hardware strings for captures whose log carries no hardware
 * metadata (PresentMon CSV). These are display-only sentinels: canonical-id
 * resolution must skip them — a shared "Unknown GPU" hardware row would bucket
 * unrelated machines together in per-hardware aggregates (§4.4).
 */
export const UNKNOWN_HARDWARE = {
  gpu: "Unknown GPU",
  cpu: "Unknown CPU",
} as const;

/**
 * Upload/abuse guardrails (§11.10). Enforced client-side for fast feedback and
 * server-side as the real gate — reject BEFORE issuing a presigned URL where
 * possible (an unbounded multi-hour capture is a storage-DoS vector).
 */
export const INGEST_LIMITS = {
  /** ~2.3 h at 60 fps; keeps the Parquet far below the server read cap. */
  maxFramesPerRun: 500_000,
  /**
   * Hard cap on the uploaded Parquet. The web app's R2 MAX_OBJECT_READ_BYTES
   * is defined AS this constant, so the verification worker can always read
   * back an object the API accepted — equal by construction, not by test.
   */
  maxParquetBytes: 64 * 1024 * 1024,
  /** Below this a capture is noise, not a benchmark. */
  minFramesPerRun: 10,
  /** Unfinalized `pending` runs older than this are reaped (§11.11). */
  stalePendingTtlHours: 24,
} as const;
