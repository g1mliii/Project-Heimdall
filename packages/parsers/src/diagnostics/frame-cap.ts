import { DIAGNOSTICS } from "@heimdall/shared";

/** Return the configured common cap whose cadence matches a frame time. */
export function commonCapFpsForFrameTime(frameTimeMs: number): number | undefined {
  if (!Number.isFinite(frameTimeMs) || frameTimeMs <= 0) return undefined;

  return DIAGNOSTICS.commonFrameCapFps.find((fps) => {
    const capFrameTimeMs = 1000 / fps;
    return (
      Math.abs(frameTimeMs - capFrameTimeMs) <=
      capFrameTimeMs * DIAGNOSTICS.frameCapToleranceFraction
    );
  });
}

export function hasStableCommonFrameCap(
  frameTimes: ArrayLike<number>,
  medianFrameTimeMs: number,
): boolean {
  const capFps = commonCapFpsForFrameTime(medianFrameTimeMs);
  if (capFps === undefined) return false;

  const capFrameTimeMs = 1000 / capFps;
  let observed = 0;
  let atCap = 0;
  for (let i = 0; i < frameTimes.length; i++) {
    const frameTimeMs = frameTimes[i];
    if (frameTimeMs === undefined || !Number.isFinite(frameTimeMs)) continue;
    observed++;
    if (
      Math.abs(frameTimeMs - capFrameTimeMs) <=
      capFrameTimeMs * DIAGNOSTICS.frameCapToleranceFraction
    ) {
      atCap++;
    }
  }
  return observed > 0 && atCap / observed >= DIAGNOSTICS.frameCapMinStableFraction;
}
