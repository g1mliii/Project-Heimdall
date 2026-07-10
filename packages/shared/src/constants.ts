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
