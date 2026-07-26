/**
 * §8.6.1/§8.6.8 — busy-time readiness copy for the capture capability panel and
 * the chart's overlay control.
 *
 * The verdict itself is `busyTelemetryReadiness` in `@heimdall/shared`, which
 * the diagnostics engine gates on too — so the panel can't print "not
 * frame-safe" under a finding that fired. This module owns only the wording,
 * stated once per cause in both voices. Skip-never-fail: an absent sensor is a
 * limit of the source log, never a fault in the run.
 */

import {
  busyTelemetryReadiness,
  type BusyTelemetryUnavailableCause,
  type CapabilityManifest,
  type HagsState,
} from "@heimdall/shared";

export const HAGS_QUALIFICATION =
  " GPU busy timing is HAGS-affected, so GPU-bound attribution is approximate — never a hard flag.";

/**
 * `no-samples` is chart-only: the manifest declared busy time, but the decoded
 * frames carry none. The manifest causes come from shared.
 */
export type BusyUnavailableCause = BusyTelemetryUnavailableCause | "no-samples";

export type BusyReadiness = { kind: "ready" } | { kind: "unavailable"; cause: BusyUnavailableCause };

interface BusyCopy {
  /** Panel-side: the verdict as a readiness diagnostic. */
  title: string;
  panel: string;
  /** Chart-side: why the overlay control is off, in the reader's terms. */
  chart: string;
}

const UNAVAILABLE_COPY: Record<BusyUnavailableCause, BusyCopy> = {
  "no-manifest": {
    title: "Bottleneck data unknown",
    panel:
      "Capture capability is unknown for this run, so bottleneck attribution and the busy-time overlay are unavailable. That is a limit of the source log, not a fault in the run.",
    chart: "Capture capability is unknown for this run, so the busy-time overlay is unavailable.",
  },
  absent: {
    title: "Bottleneck data absent",
    panel:
      "This capture carries no CPU/GPU busy-time telemetry, so bottleneck attribution and the busy-time overlay are unavailable. That is a limit of the source log, not a fault in the run.",
    chart:
      "This capture carries no CPU/GPU busy-time telemetry, so the busy-time overlay and bottleneck attribution are unavailable.",
  },
  periodic: {
    title: "Bottleneck data not frame-safe",
    panel:
      "Busy-time telemetry in this capture is periodically sampled, not per-frame — not safe for bottleneck attribution.",
    chart:
      "Busy-time telemetry in this capture is periodically sampled, not per-frame — it can't be drawn honestly against per-frame timing.",
  },
  "no-samples": {
    title: "Bottleneck data absent",
    panel:
      "The decoded frames carry no busy-time samples, so bottleneck attribution and the busy-time overlay are unavailable.",
    chart: "The decoded frames carry no busy-time samples, so the overlay is unavailable.",
  },
};

/** The manifest half of the gate, in this module's cause vocabulary. */
export function busyReadinessFromManifest(manifest?: CapabilityManifest): BusyReadiness {
  return busyTelemetryReadiness(manifest);
}

/** Chart-side wording: why the overlay control is off. */
export function busyOverlayReason(cause: BusyUnavailableCause): string {
  return UNAVAILABLE_COPY[cause].chart;
}

/** The HAGS caveat, appended wherever GPU-bound attribution is stated. */
export function hagsQualification(hags: HagsState | undefined): string {
  return hags === "enabled" ? HAGS_QUALIFICATION : "";
}

/** Panel-side wording: the same verdict stated as a readiness diagnostic. */
export function busyReadinessDiagnostic(
  readiness: BusyReadiness,
  hags: HagsState | undefined,
): { severity: "good" | "info"; title: string; message: string } {
  if (readiness.kind === "unavailable") {
    const { title, panel } = UNAVAILABLE_COPY[readiness.cause];
    return { severity: "info", title, message: panel };
  }
  return {
    severity: "good",
    title: "Bottleneck data ready",
    message:
      "CPU and GPU busy-time telemetry is frame-aligned — bottleneck attribution and the busy-time overlay are available." +
      hagsQualification(hags),
  };
}
