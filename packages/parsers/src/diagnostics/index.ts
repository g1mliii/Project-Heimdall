/**
 * Diagnostics rules engine (§15) — the public entry point. `runDiagnostics`
 * evaluates every rule over one run's columnar view, gating each on its declared
 * required sensors (§15.5) before evaluation and collecting the non-null
 * findings. It is pure and total: a rule that throws is swallowed so a single
 * bad rule can never fail verification (property-tested — the engine never
 * throws for any input).
 */

import type { FrameSample } from "@heimdall/shared";

import {
  DIAGNOSTIC_SENSOR_FIELDS,
  type DiagnosticFinding,
  type DiagnosticRule,
  type DiagnosticSensorField,
  type DiagnosticsFrameColumns,
  type DiagnosticsInput,
} from "./types";
import { vramSaturationRule } from "./vram-saturation";
import { cpuBottleneckRule } from "./cpu-bottleneck";
import { ramBelowRatedRule } from "./ram-below-rated";
import { gpuDriverOutdatedRule } from "./gpu-driver-outdated";

export * from "./types";
export { compareDriverVersions } from "./gpu-driver-outdated";

/** Registry order == render order for findings of equal salience. */
export const DIAGNOSTIC_RULES: readonly DiagnosticRule[] = [
  vramSaturationRule,
  cpuBottleneckRule,
  ramBelowRatedRule,
  gpuDriverOutdatedRule,
];

/**
 * A sensor column counts as available when it is attached to the columnar
 * input. The worker and `framesToColumns` only attach one after observing a
 * real value, so this avoids a redundant full scan of every 500k-frame sensor
 * buffer before the rules that actually consume it run.
 */
function availableSensors(frames: DiagnosticsFrameColumns): Set<DiagnosticSensorField> {
  const available = new Set<DiagnosticSensorField>();
  for (const field of DIAGNOSTIC_SENSOR_FIELDS) {
    if (frames[field]) available.add(field);
  }
  return available;
}

/**
 * Run all diagnostics for one run. Findings come back in registry order; an
 * empty array means a clean run (§16 — no false positives). Never throws.
 */
export function runDiagnostics(input: DiagnosticsInput): DiagnosticFinding[] {
  const frameCount = input.frames.frameTimeMs.length;
  const available = availableSensors(input.frames);
  const findings: DiagnosticFinding[] = [];

  for (const rule of DIAGNOSTIC_RULES) {
    if (!rule.requiredSensors.every((sensor) => available.has(sensor))) continue;
    let verdict: ReturnType<DiagnosticRule["evaluate"]>;
    try {
      verdict = rule.evaluate({
        input,
        frameCount,
        hasSensor: (field) => available.has(field),
      });
    } catch {
      // A rule must never fail the whole run; treat a throw as "did not fire".
      continue;
    }
    if (!verdict) continue;
    // `requiredSensors` gates the rule above (§15.5) but is not part of the
    // emitted/persisted finding — it would be dead weight the storage layer drops.
    findings.push({
      code: rule.code,
      severity: verdict.severity,
      title: verdict.title,
      detail: verdict.detail,
    });
  }

  return findings;
}

/**
 * Build the engine's columnar input from a `FrameSample[]` — test ergonomics
 * only (the worker feeds typed arrays straight from the Parquet decode). A
 * sensor column is included only when at least one frame carries it; absent
 * per-frame values become `NaN` so the engine skips them.
 */
export function framesToColumns(frames: readonly FrameSample[]): DiagnosticsFrameColumns {
  const n = frames.length;
  const frameTimeMs = new Float64Array(n);
  const present: Record<DiagnosticSensorField, boolean> = {
    vramUsedMb: false,
    gpuLoadPct: false,
    cpuLoadPct: false,
  };
  for (const frame of frames) {
    for (const field of DIAGNOSTIC_SENSOR_FIELDS) {
      if (frame[field] !== undefined) present[field] = true;
    }
  }

  const columns: DiagnosticsFrameColumns = { frameTimeMs };
  for (const field of DIAGNOSTIC_SENSOR_FIELDS) {
    if (present[field]) columns[field] = new Float64Array(n).fill(NaN);
  }
  for (let i = 0; i < n; i++) {
    const frame = frames[i]!;
    frameTimeMs[i] = frame.frameTimeMs;
    for (const field of DIAGNOSTIC_SENSOR_FIELDS) {
      const column = columns[field];
      const value = frame[field];
      if (column && value !== undefined) (column as Float64Array)[i] = value;
    }
  }
  return columns;
}
