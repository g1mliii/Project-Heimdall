import { DIAGNOSTICS } from "@heimdall/shared";
import type { DiagnosticRuleContext } from "./types";

/** A configured cap's cadence, resolved once so a scan needn't re-derive it. */
export interface FrameCapCadence {
  fps: number;
  frameTimeMs: number;
  toleranceMs: number;
}

function frameCapCadence(fps: number): FrameCapCadence {
  const frameTimeMs = 1000 / fps;
  return { fps, frameTimeMs, toleranceMs: frameTimeMs * DIAGNOSTICS.frameCapToleranceFraction };
}

/**
 * Whether a frame time sits at this cadence.
 *
 * Keep the `|x - c| <= t` form. Rearranging it into a precomputed `[c-t, c+t]`
 * window is algebraically identical but NOT identical in floating point, and the
 * bands are tight enough that real frame times land exactly on the boundary —
 * 13 ms against the 75 FPS cadence flips between the two forms.
 */
export function holdsCadence(cadence: FrameCapCadence, frameTimeMs: number): boolean {
  return Math.abs(frameTimeMs - cadence.frameTimeMs) <= cadence.toleranceMs;
}

/** Return the configured common cap whose cadence matches a frame time. */
export function commonCapFpsForFrameTime(frameTimeMs: number): number | undefined {
  if (!Number.isFinite(frameTimeMs) || frameTimeMs <= 0) return undefined;

  return DIAGNOSTICS.commonFrameCapFps.find((fps) => holdsCadence(frameCapCadence(fps), frameTimeMs));
}

/**
 * The one cadence this capture actually holds, or `undefined`.
 *
 * A cap is a property of the CAPTURE, never of a lone frame: the configured
 * cadences are dense enough that adjacent bands touch (72 and 75 FPS cover a
 * contiguous 13.00–14.24 ms span), so an ordinary uncapped frame time lands in
 * some band by coincidence. Evidence of a real cap is the median sitting at a
 * cadence AND the capture holding that same cadence across
 * `frameCapMinStableFraction` of its frames.
 */
export function stableCommonFrameCap(
  frameTimes: ArrayLike<number>,
  medianFrameTimeMs: number,
): FrameCapCadence | undefined {
  const capFps = commonCapFpsForFrameTime(medianFrameTimeMs);
  if (capFps === undefined) return undefined;

  const cadence = frameCapCadence(capFps);
  let observed = 0;
  let atCap = 0;
  for (let i = 0; i < frameTimes.length; i++) {
    const frameTimeMs = frameTimes[i];
    if (frameTimeMs === undefined || !Number.isFinite(frameTimeMs)) continue;
    observed++;
    if (holdsCadence(cadence, frameTimeMs)) atCap++;
  }
  return observed > 0 && atCap / observed >= DIAGNOSTICS.frameCapMinStableFraction
    ? cadence
    : undefined;
}

/**
 * `runDiagnostics` shares one context among all rules, and more than one rule
 * asks about the cap. A WeakMap keeps the O(frameCount) scan to once per
 * invocation without retaining captures after the engine returns — the same
 * memo `bottleneck-attribution` uses for its own scan.
 */
const capByContext = new WeakMap<DiagnosticRuleContext, FrameCapCadence | undefined>();

/** {@link stableCommonFrameCap} for the shared rule context, scanned at most once. */
export function contextStableCommonFrameCap(
  ctx: DiagnosticRuleContext,
): FrameCapCadence | undefined {
  // `undefined` is a real result here, so probe with `has` rather than treating
  // a missing entry and a cached "no cap" as the same thing.
  if (capByContext.has(ctx)) return capByContext.get(ctx);

  const cadence = stableCommonFrameCap(
    ctx.input.frames.frameTimeMs,
    ctx.input.summary.frameTimeP50Ms,
  );
  capByContext.set(ctx, cadence);
  return cadence;
}

export function hasStableCommonFrameCap(
  frameTimes: ArrayLike<number>,
  medianFrameTimeMs: number,
): boolean {
  return stableCommonFrameCap(frameTimes, medianFrameTimeMs) !== undefined;
}
