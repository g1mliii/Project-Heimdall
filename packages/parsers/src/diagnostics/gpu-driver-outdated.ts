/**
 * GPU-driver-outdated rule (§15.4). Compares the captured driver version against
 * a curated per-game minimum threaded in as `game.requiredDriver`. The same
 * comparator also powers the Phase 6.6 latest-driver currency signal. Both are
 * vendor/OS-selected by the repository and self-suppress when data is absent,
 * stale, or version formats cannot be normalized safely.
 */

import type { GpuVendor } from "@heimdall/shared";
import type {
  DiagnosticRule,
  DiagnosticsInput,
  DriverComponent,
  DriverPlatform,
} from "./types";

/**
 * NVIDIA GeForce marketing driver format, e.g. `566.36` / `610.74` — a
 * three-digit branch and a two-plus-digit build. Other vendor/OS cells retain
 * the numeric version token published by their own source.
 */
const NVIDIA_WINDOWS_VERSION = /^\d{3}\.\d{2,}(?:\.\d+)?$/;
// AMD's Windows Driver Store package versions (for example
// `32.0.31019.2002`) are not comparable with Adrenalin releases such as
// `26.6.4`. A capture that supplies only this package token must no-op rather
// than falsely appear newer than the curated Adrenalin version.
const AMD_WINDOWS_DRIVER_STORE_VERSION = /^\d+\.\d+\.\d+\.\d+$/;
const VERSION_TOKEN = /\d+(?:\.\d+)+/;

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

/**
 * Convert a captured/vendor version into a comparator-safe numeric token.
 * NVIDIA's Windows Device Manager form (`31.0.15.6636`) is mapped to its
 * marketing equivalent (`566.36`); every other supported cell compares the
 * numeric version token already emitted by its source/MangoHud.
 */
export function normalizeDriverVersion(
  value: string,
  vendor: GpuVendor,
  os: DriverPlatform,
  component: DriverComponent,
): string | null {
  const token = value.match(VERSION_TOKEN)?.[0];
  if (!token) return null;

  if (vendor === "nvidia" && os === "windows" && component === "gpu") {
    if (NVIDIA_WINDOWS_VERSION.test(token)) return token;
    const windows = token.match(/^\d{2}\.0\.1(\d)\.(\d{4})$/);
    if (!windows) return null;
    const branchTail = windows[1]!;
    const build = windows[2]!;
    return `${branchTail}${build.slice(0, -2)}.${build.slice(-2)}`;
  }

  if (
    vendor === "amd" &&
    os === "windows" &&
    component === "gpu" &&
    AMD_WINDOWS_DRIVER_STORE_VERSION.test(token)
  ) {
    return null;
  }

  return token;
}

function comparableVersions(
  captured: string,
  expected: string,
  vendor: GpuVendor,
  os: DriverPlatform,
  component: DriverComponent,
): [string, string] | null {
  const left = normalizeDriverVersion(captured, vendor, os, component);
  const right = normalizeDriverVersion(expected, vendor, os, component);
  return left && right ? [left, right] : null;
}

/**
 * The game-ready shortfall, when a curated per-game minimum outranks the
 * captured driver. Shared by both rules below so they agree on exactly one
 * definition of "older than this game wants".
 */
function requiredDriverShortfall(
  input: DiagnosticsInput,
): { driver: string; required: string } | null {
  const driver = input.hardware.gpuDriver;
  const required = input.game?.requiredDriver;
  const platform = input.driverPlatform;
  if (!driver || !required || !platform || input.vendor === "unknown") return null;
  if (platform.vendor !== input.vendor || platform.component !== "gpu") return null;
  const versions = comparableVersions(driver, required, input.vendor, platform.os, "gpu");
  if (!versions || compareDriverVersions(...versions) >= 0) return null;
  return { driver, required };
}

export const driverUpdateAvailableRule: DiagnosticRule = {
  code: "driver-update-available",
  version: "1.1.0",
  requiredSensors: [],
  evaluate({ input }) {
    const captured = input.hardware.gpuDriver;
    const catalog = input.driverCatalog;
    const platform = input.driverPlatform;
    if (!captured || !catalog || !platform || input.vendor === "unknown") return null;
    // Both rules say "update your driver"; a driver below the curated per-game
    // minimum is also below the catalog's latest, so firing both would render
    // two overlapping recommendations. The game-ready finding names a concrete
    // target version, so the generic one stands down for it.
    if (requiredDriverShortfall(input) !== null) return null;
    if (
      catalog.vendor !== input.vendor ||
      platform.vendor !== catalog.vendor ||
      platform.os !== catalog.os ||
      platform.component !== catalog.component
    ) {
      return null;
    }

    const versions = comparableVersions(
      captured,
      catalog.latestVersion,
      input.vendor,
      catalog.os,
      catalog.component,
    );
    if (!versions || compareDriverVersions(...versions) >= 0) return null;

    return {
      severity: "info",
      title: "GPU driver update available",
      detail:
        `This capture uses ${captured}; the latest known ${catalog.component === "mesa" ? "Mesa" : `${input.vendor.toUpperCase()} driver`} ` +
        `is ${catalog.latestVersion}. Updating can improve compatibility and stability.`,
      evidence: {
        provenance: {
          ...(catalog.sourceUrl === undefined ? {} : { sourceUrl: catalog.sourceUrl }),
          latestVersion: catalog.latestVersion,
          ...(catalog.fetchedAt === undefined ? {} : { catalogFetchedAt: catalog.fetchedAt }),
        },
      },
    };
  },
};

export const gpuDriverOutdatedRule: DiagnosticRule = {
  code: "gpu-driver-outdated",
  version: "1.1.0",
  requiredSensors: [],
  evaluate({ input }) {
    const shortfall = requiredDriverShortfall(input);
    if (shortfall === null) return null;
    const { driver, required } = shortfall;

    return {
      severity: "info",
      title: "GPU driver is older than recommended",
      detail:
        `This game runs best on GPU driver ${required} or newer, but this capture is on ` +
        `${driver}. Updating your driver can improve stability and performance.`,
      evidence: {
        provenance: {
          ...(input.game?.requiredDriverSourceUrl === undefined
            ? {}
            : { sourceUrl: input.game.requiredDriverSourceUrl }),
          latestVersion: required,
          ...(input.game?.requiredDriverFetchedAt === undefined
            ? {}
            : { catalogFetchedAt: input.game.requiredDriverFetchedAt }),
        },
      },
    };
  },
};
