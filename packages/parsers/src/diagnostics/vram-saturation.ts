/**
 * VRAM-saturation stutter rule (§15.1). When a run's stutters cluster on frames
 * where VRAM sat at/above {@link DIAGNOSTICS.vramSaturationFraction} of total
 * capacity, the stutters are almost certainly the GPU evicting/streaming assets
 * — the actionable fix is lowering texture quality or resolution.
 *
 * Requires the `vramUsedMb` sensor AND a known total capacity
 * (`hardware.gpuVramTotalMb`, best-effort from the parsers); no-ops otherwise.
 */

import { DIAGNOSTICS } from "@heimdall/shared";
import { stutterThresholdMs } from "../metrics";
import type { DiagnosticRule } from "./types";

export const vramSaturationRule: DiagnosticRule = {
  code: "vram-saturation-stutter",
  requiredSensors: ["vramUsedMb"],
  evaluate({ input, frameCount }) {
    const totalMb = input.hardware.gpuVramTotalMb;
    const vram = input.frames.vramUsedMb;
    if (totalMb === undefined || totalMb <= 0 || !vram) return null;

    const saturatedMb = totalMb * DIAGNOSTICS.vramSaturationFraction;
    const stutterMs = stutterThresholdMs(input.summary.frameTimeP50Ms);
    const frameTimes = input.frames.frameTimeMs;

    let stutters = 0;
    let saturatedStutters = 0;
    let peakMb = 0;
    for (let i = 0; i < frameCount; i++) {
      const raw = vram[i];
      const frameTimeMs = frameTimes[i];
      const usedMb = raw !== undefined && Number.isFinite(raw) ? raw : undefined;
      if (usedMb !== undefined && usedMb > peakMb) peakMb = usedMb;
      if (frameTimeMs !== undefined && frameTimeMs > stutterMs) {
        stutters++;
        if (usedMb !== undefined && usedMb >= saturatedMb) saturatedStutters++;
      }
    }

    if (stutters === 0) return null;
    if (saturatedStutters / stutters < DIAGNOSTICS.vramStutterOverlapFraction) return null;

    const peakPct = Math.round((peakMb / totalMb) * 100);
    return {
      severity: "bad",
      title: "VRAM saturation is causing stutters",
      detail:
        `VRAM peaked at ~${Math.round(peakMb)} MB of ${Math.round(totalMb)} MB (${peakPct}%), and ` +
        `${saturatedStutters} of ${stutters} stutters happened while VRAM was full. ` +
        `Lower texture quality or resolution to free up VRAM headroom.`,
    };
  },
};
