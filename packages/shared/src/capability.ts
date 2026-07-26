/**
 * Busy-time telemetry readiness (§16b.1/§8.6.1) — the single answer to "can
 * CPU/GPU busy time be trusted for this run?".
 *
 * Both the diagnostics engine (whether a bottleneck-attribution rule may fire
 * at all) and the run page (the capability panel and the chart's overlay
 * control) gate on this. They render one above the other, so a second copy of
 * the ladder would let the panel print "not frame-safe" directly under a
 * `likely-cpu-bound` finding. Copy lives with each surface; the verdict lives
 * here.
 */

import type { CapabilityManifest } from "./types";

/**
 * Why busy time can't be trusted. `no-manifest` means the run predates the
 * capability contract entirely — unknown, never "absent".
 */
export type BusyTelemetryUnavailableCause = "no-manifest" | "absent" | "periodic";

export type BusyTelemetryReadiness =
  | { kind: "ready" }
  | { kind: "unavailable"; cause: BusyTelemetryUnavailableCause };

/** What the capture *declares* it could see. Skip-never-fail: absence is a limit, not a fault. */
export function busyTelemetryReadiness(manifest?: CapabilityManifest): BusyTelemetryReadiness {
  if (!manifest) return { kind: "unavailable", cause: "no-manifest" };
  const cpu = manifest.sensors.cpuBusyMs;
  const gpu = manifest.sensors.gpuBusyMs;
  if (!cpu.present || !gpu.present) return { kind: "unavailable", cause: "absent" };
  if (!cpu.frameAligned || !gpu.frameAligned) return { kind: "unavailable", cause: "periodic" };
  return { kind: "ready" };
}

/** Boolean shorthand for callers that only gate, and never explain why. */
export function hasFrameAlignedBusyTelemetry(manifest?: CapabilityManifest): boolean {
  return busyTelemetryReadiness(manifest).kind === "ready";
}
