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
 * Current ingest schema version. Bump when the wire DTO changes incompatibly so
 * stored uploads can be reprocessed against the right shape (§2.2).
 */
export const CURRENT_SCHEMA_VERSION = 1;
