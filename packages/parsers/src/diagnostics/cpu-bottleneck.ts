/**
 * CPU-bottleneck rule (§15.2). A CPU-bound run shows the CPU pegged while the
 * GPU has load to spare; when that pattern covers a meaningful share of frames
 * the GPU is being starved, and a faster CPU (or lower CPU-bound settings /
 * higher resolution to shift work back to the GPU) is the fix.
 *
 * Requires both `cpuLoadPct` and `gpuLoadPct`; no-ops otherwise. A stable
 * common FPS cap is intentionally treated as inconclusive: the telemetry can
 * look CPU-bound while the game is simply honoring a user/display limiter.
 */

import { DIAGNOSTICS } from "@heimdall/shared";
import type { DiagnosticRule } from "./types";
import { hasStableCommonFrameCap } from "./frame-cap";

export const cpuBottleneckRule: DiagnosticRule = {
  code: "cpu-bottleneck",
  version: "1.0.0",
  requiredSensors: ["cpuLoadPct", "gpuLoadPct"],
  evaluate({ input, frameCount }) {
    const sensors = input.capabilityManifest?.sensors;
    // SensorData2 utilization samples are periodically polled, not tied to a
    // specific presented frame. They remain useful for display/telemetry, but
    // must not drive a per-frame bottleneck finding.
    if (
      sensors &&
      (!sensors.cpuLoadPct.frameAligned || !sensors.gpuLoadPct.frameAligned)
    ) {
      return null;
    }
    const cpu = input.frames.cpuLoadPct;
    const gpu = input.frames.gpuLoadPct;
    if (!cpu || !gpu) return null;
    if (hasStableCommonFrameCap(input.frames.frameTimeMs, input.summary.frameTimeP50Ms)) {
      return null;
    }

    let considered = 0;
    let affected = 0;
    for (let i = 0; i < frameCount; i++) {
      const cpuLoad = cpu[i];
      const gpuLoad = gpu[i];
      if (
        cpuLoad === undefined ||
        gpuLoad === undefined ||
        !Number.isFinite(cpuLoad) ||
        !Number.isFinite(gpuLoad)
      ) {
        continue;
      }
      considered++;
      if (cpuLoad >= DIAGNOSTICS.cpuBottleneckCpuPct && gpuLoad <= DIAGNOSTICS.cpuBottleneckGpuPct) {
        affected++;
      }
    }

    if (considered < DIAGNOSTICS.cpuBottleneckMinTelemetrySamples) return null;
    const telemetryCoverage = considered / frameCount;
    if (telemetryCoverage < DIAGNOSTICS.cpuBottleneckMinTelemetryCoverageFraction) return null;

    // Use the full capture as the denominator. A sparse telemetry column must
    // not turn one observed CPU-bound frame into a claim about the whole run.
    const affectedFraction = affected / frameCount;
    if (affectedFraction < DIAGNOSTICS.cpuBottleneckMinAffectedFraction) return null;

    const affectedPct = Math.round(affectedFraction * 100);
    return {
      severity: "warn",
      title: "CPU is bottlenecking the GPU",
      detail:
        `For ${affectedPct}% of frames the CPU was maxed out (≥${DIAGNOSTICS.cpuBottleneckCpuPct}%) ` +
        `while the GPU idled (≤${DIAGNOSTICS.cpuBottleneckGpuPct}%). A faster CPU — or raising ` +
        `resolution/graphics settings to shift work back to the GPU — would raise your frame rate.`,
    };
  },
};
