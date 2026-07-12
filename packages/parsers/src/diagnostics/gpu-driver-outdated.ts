/**
 * GPU-driver-outdated rule (§15.4). Compares the captured driver version against
 * a curated per-game minimum (`games.required_driver`, seeded in the DB and
 * threaded in as `game.requiredDriver`). Vendor-gated and self-suppressing: with
 * no curated value, an unknown vendor, or an unparseable version, it stays
 * silent. Informational only — an old driver is advice, never a validity gate.
 */

import type { DiagnosticRule } from "./types";

/**
 * NVIDIA GeForce marketing driver format, e.g. `566.36` / `566.14` — a
 * three-digit branch and a two-plus-digit build. The curated seed (§15.4) holds
 * ONLY these, so we compare against them alone: a Windows quad-format string
 * (`31.0.15.6636`) or an AMD/Intel version has an incompatible segment layout
 * and must not be numerically compared (Phase 6.6 makes this vendor/OS-aware).
 */
const NVIDIA_MARKETING_VERSION = /^\d{3}\.\d{2,}$/;

/** Split a driver string into its numeric segments (`"31.0.15.6636"` → [31,0,15,6636]). */
function versionSegments(version: string): number[] {
  return version
    .split(/[^0-9]+/)
    .filter((part) => part.length > 0)
    .map(Number)
    .filter((n) => Number.isFinite(n));
}

/**
 * Numeric-segment version compare: <0 when `a` is older than `b`, >0 when
 * newer, 0 when equal OR either side is unparseable (so the caller no-ops
 * rather than guessing). Shorter versions are zero-extended (`566` == `566.0`).
 */
export function compareDriverVersions(a: string, b: string): number {
  const left = versionSegments(a);
  const right = versionSegments(b);
  if (left.length === 0 || right.length === 0) return 0;
  const length = Math.max(left.length, right.length);
  for (let i = 0; i < length; i++) {
    const x = left[i] ?? 0;
    const y = right[i] ?? 0;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

export const gpuDriverOutdatedRule: DiagnosticRule = {
  code: "gpu-driver-outdated",
  requiredSensors: [],
  evaluate({ input }) {
    const driver = input.hardware.gpuDriver;
    const required = input.game?.requiredDriver;
    if (!driver || !required) return null;
    // The seed is NVIDIA-only and vendorless; comparing an AMD/Intel string (or
    // an NVIDIA Windows quad-format string) against it is a §16.2 false positive.
    if (input.vendor !== "nvidia") return null;
    if (!NVIDIA_MARKETING_VERSION.test(driver) || !NVIDIA_MARKETING_VERSION.test(required)) {
      return null;
    }
    if (compareDriverVersions(driver, required) >= 0) return null;

    return {
      severity: "info",
      title: "GPU driver is older than recommended",
      detail:
        `This game runs best on GPU driver ${required} or newer, but this capture is on ` +
        `${driver}. Updating your driver can improve stability and performance.`,
    };
  },
};
