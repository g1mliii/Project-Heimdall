/**
 * Statistical-integrity and canonical-summary thresholds, as named constants
 * (IMPLEMENTATION_PLAN §1.3). Phase 7 (§18) consumes these; Phase 1 (§2.3) may
 * extend this file. Centralized so the integrity math has a single source of truth.
 * See docs/integrity-and-privacy.md §2.
 */

import { GENERATED_FRAME_TECH } from "./constants";
import type { GeneratedFrameTech } from "./types";

/** Statistical outlier rejection — Phase 7 §18.2. */
export const OUTLIER = {
  /** Scales median absolute deviation to its normal-distribution equivalent. */
  madScale: 0.6745,
  /** Modified z-score (MAD-based) magnitude above which a run is an outlier. */
  madZScoreThreshold: 3.5,
  /** Fallback sigma multiplier when MAD is degenerate (zero spread). */
  sigmaThreshold: 3,
  /**
   * Minimum runs for a given game + canonical GPU before distributions and
   * automatic outlier hiding activate. Below this, show raw runs labelled
   * "insufficient data" — never a bell curve (§17.4) — and outlier rejection
   * stays inert (§18.2).
   */
  minSampleSize: 30,
} as const;

/**
 * Server recompute threshold (§11.5). Per-frame telemetry remains explanatory:
 * the available CPU/GPU utilisation fields are whole-machine aggregates and
 * cannot safely establish that a run is fabricated.
 */
export const PHYSICS = {
  /** Allowed fractional gap between the client-submitted and server-recomputed summary. */
  recomputeTolerance: 0.01,
} as const;

/**
 * Reconcile a declared frame-generation tech against what the frames show
 * (§11.5, §22.11).
 *
 * ONE definition, imported by both sides: `@heimdall/ingest-client` applies it
 * at create and the verify worker re-applies it at finalize against the
 * server's own recompute. They each carried a copy before this and had already
 * drifted — the client kept a declared `none` that the server then rewrote.
 *
 * ── A zero count is not evidence of absence ─────────────────────────────────
 *
 * A generated frame is only visible where the capture reports frame type AND
 * something instrumented it. PresentMon's `--track_frame_type` requires
 * "application and/or driver instrumentation using Intel-PresentMon provider",
 * which AMD's driver does not emit: an RX 9070 XT running Cyberpunk 2077 with
 * frame generation ON produced 14,241 rows, every one labelled `Application`,
 * at 243.9 avg FPS against 130.7 with it off. A `FrameType` column full of
 * `Application` is therefore indistinguishable from an uninstrumented one, and
 * the column's PRESENCE proves nothing at all — which is why this rule keys on
 * generated frames having been SEEN, and never on the column existing.
 *
 * * Frames were generated → generation is a fact, and a declaration cannot
 *   deny an observation. It only gets to NAME the tech.
 * * No generated frames → nothing is proven either way, so the declaration
 *   stands as declared, `unknown` included. Callers that were told nothing pass
 *   `unknown` and get `unknown`; nobody gets a manufactured `none`.
 *
 * `none` is consequently only ever recorded because a human declared it — the
 * same trust `upscaler`, `rayTracing`, `settingsPreset` and `scene` already
 * get, and all of those are comparability keys too. Detecting UNDECLARED
 * generation from within a run is Phase 9.6 (§22.13); it cannot be done from a
 * frame-type column that no driver fills in.
 */
export function reconcileGeneratedFrameTech(
  declared: GeneratedFrameTech,
  recomputedGeneratedFramePct: number,
): GeneratedFrameTech {
  if (recomputedGeneratedFramePct > 0) {
    // Generated frames are in the data. `none` is now a contradiction and
    // `unknown` names nothing, so both resolve to "generated, tech unknown".
    return declared === GENERATED_FRAME_TECH.none || declared === GENERATED_FRAME_TECH.unknown
      ? GENERATED_FRAME_TECH.unknown
      : declared;
  }
  // Nothing observed. The frames get no say, because they had no way to look.
  return declared;
}
