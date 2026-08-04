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
  /**
   * Allowed fractional gap between the client-submitted and server-recomputed
   * summary.
   *
   * NOT the tolerance `summaryMismatch` actually applies. The §11.5 gate uses
   * `floatsMatch` (a 1e-6 relative epsilon) because the same `computeRunSummary`
   * code runs on both sides over DOUBLE columns — honest uploads are bit-
   * identical, so the epsilon only absorbs serialization noise. Adopting 0.01
   * there would loosen the gate by four orders of magnitude and let real
   * tampering through. See the comment at `floatsMatch` in
   * `apps/web/src/lib/jobs/verify-run.ts`.
   */
  recomputeTolerance: 0.01,
} as const;

/**
 * Frame-generation physics evidence (§22.13) — CHARACTERISATION ONLY.
 *
 * These thresholds shape the statistics stored in `runs.present_time_profile`.
 * **No rule reads them, no run is annotated, and nothing reaches the wire.**
 * The signal is real — an RX 9070 XT showed a 0.32 ms minimum present with
 * frame generation on against 3.11 ms with it off, and a 0.32 ms present is not
 * a plausible rendered frame at that resolution — but the evidence in hand is
 * one GPU, one title, one resolution.
 *
 * A threshold fitted to n = 1 that accuses honest uploaders is the failure §0.5
 * exists to prevent: telling an honest uploader their run looks like cheating is
 * a worse failure than missing a dishonest one, and a false positive is
 * unfalsifiable from the uploader's side. The statistics accumulate from real
 * uploads until they can be calibrated across vendors; the rule gets its own
 * phase then. See `docs/frame-generation.md`.
 */
export const FRAME_GENERATION_EVIDENCE = {
  /**
   * Presents at or below this duration are counted as sub-millisecond. Well
   * above `MIN_FRAME_TIME_MS` (0.01), so these presents survive parsing and the
   * signal reaches storage intact.
   */
  subMillisecondPresentMs: 1,
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
