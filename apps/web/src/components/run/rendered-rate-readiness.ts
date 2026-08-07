/**
 * §22.12 — rendered-rate readiness copy for the run report's rate toggle.
 *
 * A structural copy of `busy-readiness.ts`: one module owns the verdict and its
 * reason string, so the toggle, the caption and the tests all state the same
 * thing. The verdict itself is decided server-side (the
 * `RenderedFrameAnalysis` discriminated union) — this module owns only the
 * wording.
 *
 * Skip-never-fail, as everywhere else: a capture that cannot report frame type
 * is describing a limit of the source log, never a fault in the run. The
 * control is disabled with a VISIBLE reason rather than hidden, because
 * silently omitting it would leave a frame-generated run's presented numbers
 * looking like the whole story.
 */

import type { RenderedFrameAnalysis } from "@heimdall/shared";

/** Which rate the report is currently showing. */
export const RATE_MODE = { presented: "presented", rendered: "rendered" } as const;
export type RateMode = (typeof RATE_MODE)[keyof typeof RATE_MODE];

export type RenderedRateReadiness =
  | { kind: "ready"; analysis: Extract<RenderedFrameAnalysis, { state: "available" }> }
  | { kind: "unavailable"; reason: string };

/**
 * The long form names the provider requirement, because "this capture does not
 * report frame type" invites the reasonable question "so fix the capture" — and
 * on AMD hardware there is nothing to fix. `--track_frame_type` requires
 * application or driver instrumentation through the Intel-PresentMon provider,
 * which AMD's driver does not emit (§22.6/§22.11).
 */
const NO_EVIDENCE_REASON =
  "Capture does not report frame type — a rendered-only rate cannot be computed. " +
  "Frame-type labels need application or driver instrumentation through the " +
  "Intel-PresentMon provider; AMD frame generation carries no such label, so its " +
  "presents are indistinguishable from rendered ones.";

const UNVERIFIED_REASON = "Rendered rate appears once verification recomputes this run.";

/** The toggle exists but the frames it would redraw have not arrived yet. */
const FRAMES_NOT_READY_REASON =
  "Rendered rate becomes available once the frame data finishes loading.";

function tooFewReason(renderedCount: number): string {
  const presents = renderedCount === 1 ? "1 present was" : `${renderedCount} presents were`;
  return `Only ${presents} labelled as rendered — too few to time a rendered rate.`;
}

/**
 * Turn the stored analysis into a toggle verdict.
 *
 * `undefined` means the run has not been verified yet — distinct from every
 * other case, because it resolves on its own and the copy should say so rather
 * than implying the capture is deficient.
 */
export function renderedRateReadiness(
  analysis: RenderedFrameAnalysis | undefined,
): RenderedRateReadiness {
  if (analysis === undefined) return { kind: "unavailable", reason: UNVERIFIED_REASON };
  switch (analysis.state) {
    case "available":
      return { kind: "ready", analysis };
    case "no-frame-type-evidence":
      return { kind: "unavailable", reason: NO_EVIDENCE_REASON };
    case "too-few-rendered-presents":
      return { kind: "unavailable", reason: tooFewReason(analysis.renderedCount) };
    default:
      // Unreachable for any state this build knows. Kept because the value is
      // stored jsonb written by a possibly-older FRAME_ANALYSIS_VERSION: the
      // wire schema drops an unrecognised blob to `undefined` rather than
      // throwing, and if one ever reached here it must hide the toggle, not
      // fall through to `undefined` and crash the page.
      return { kind: "unavailable", reason: UNVERIFIED_REASON };
  }
}

/**
 * Whether the toggle may be offered at all: the server has a rendered rate AND
 * the frames it would redraw have arrived.
 *
 * `renderedRateReadiness` answers "does a rendered rate exist"; this adds "can
 * the page act on it yet". An unavailable answer still names itself — a
 * disabled control with no visible reason is the §8.6.6 failure this module
 * exists to avoid, and the frames-loading case was previously the one arm that
 * fell through it silently.
 */
export function renderedRateToggleReadiness(
  readiness: RenderedRateReadiness,
  framesReady: boolean,
): RenderedRateReadiness {
  if (readiness.kind === "unavailable") return readiness;
  return framesReady ? readiness : { kind: "unavailable", reason: FRAMES_NOT_READY_REASON };
}

/**
 * Shown when the reader asked for the rendered view but coalescing the DECODED
 * frames produced nothing.
 *
 * Belt-and-braces, mirroring `busyUnavailableReason`'s check that the decoded
 * frames really carry the columns the manifest promised. The server decides
 * `available` from the full Parquet; the browser coalesces its own decode. If
 * those ever disagree the page stays on the presented view and says why, rather
 * than drawing a presented trace underneath rendered numbers.
 */
export const SERIES_UNAVAILABLE_REASON =
  "The decoded frames carry no usable frame-type column, so a rendered trace cannot be drawn.";

/**
 * Caption under the chart while the rendered rate is showing.
 *
 * States what the number IS, because "rendered FPS" is not self-explanatory:
 * a reader who assumes it means "generated frames removed" would expect the
 * presented rate back, which is exactly the naive-filter error (§22.12).
 */
export function renderedRateCaption(
  analysis: Extract<RenderedFrameAnalysis, { state: "available" }>,
): string {
  return (
    `Timed between consecutive rendered presents — ${analysis.generatedCount.toLocaleString()} ` +
    `interpolated presents are absorbed into the intervals that contain them, not dropped. ` +
    `This is how fast the game rendered; the presented rate is how smooth it felt.`
  );
}

/** Why the busy-time overlay is unavailable while the rendered rate is showing. */
export const BUSY_RENDERED_MODE_REASON =
  "CPU and GPU busy time are per-present measurements and do not survive coalescing " +
  "into rendered intervals — switch back to presented to draw them.";
