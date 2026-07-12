/**
 * Contracts for the Phase 6 diagnostics rules engine (§15). The engine is a
 * pure function over a columnar view of one run — no I/O, no throwing — so it
 * runs identically in the verification worker and in unit tests.
 *
 * Rules consume typed sensor columns rather than a `FrameSample[]` object graph
 * so the worker can feed it the same compact `Float64Array`s it already decodes
 * for the canonical summary (up to 500k frames).
 */

import {
  DIAGNOSTIC_FRAME_SENSOR_FIELDS,
  type CaptureSource,
  type DiagnosticFinding,
  type DiagnosticSeverity,
  type DiagnosticFrameSensorField,
  type GpuVendor,
  type HardwareSnapshot,
  type RunSummary,
} from "@heimdall/shared";

import type { SensorColumnField } from "../internal/columns";

/** Sensor columns the engine can gate on (a subset of the full sensor set). */
export const DIAGNOSTIC_SENSOR_FIELDS = DIAGNOSTIC_FRAME_SENSOR_FIELDS;
export type DiagnosticSensorField = DiagnosticFrameSensorField;

/** A per-frame numeric column; typed array in the worker, plain array in tests. */
export type FrameColumn = ArrayLike<number>;

/**
 * Columnar per-frame view. `frameTimeMs` is always present; sensor columns are
 * present only after at least one real sensor value was observed (an absent
 * column no-ops every rule that requires it, §15.5).
 */
export interface DiagnosticsFrameColumns {
  frameTimeMs: FrameColumn;
  vramUsedMb?: FrameColumn;
  gpuLoadPct?: FrameColumn;
  cpuLoadPct?: FrameColumn;
}

/** Curated per-game facts the engine consults (seeded in the DB, §15.4). */
export interface DiagnosticsGame {
  /** Minimum GPU driver version recommended for this game, if curated. */
  requiredDriver?: string;
}

/** Everything a rule needs about one run. */
export interface DiagnosticsInput {
  summary: RunSummary;
  hardware: HardwareSnapshot;
  source: CaptureSource;
  vendor: GpuVendor;
  game?: DiagnosticsGame;
  frames: DiagnosticsFrameColumns;
}

export type { DiagnosticFinding };

/** What a rule returns when it fires; the engine stamps on `code`/sensors. */
export interface RuleVerdict {
  severity: DiagnosticSeverity;
  title: string;
  detail: string;
}

/** Context handed to every rule. `hasSensor` reflects real per-run availability. */
export interface DiagnosticRuleContext {
  input: DiagnosticsInput;
  frameCount: number;
  hasSensor(field: DiagnosticSensorField): boolean;
}

/**
 * One rule. `requiredSensors` is gated by the engine before `evaluate` runs;
 * any additional (hardware) precondition is checked inside `evaluate`, which
 * returns `null` to no-op. A rule must never throw.
 */
export interface DiagnosticRule {
  code: string;
  requiredSensors: readonly DiagnosticSensorField[];
  evaluate(ctx: DiagnosticRuleContext): RuleVerdict | null;
}

/** Compile-time proof the engine's sensor fields are real sensor columns. */
const _sensorFieldsAreColumns: readonly SensorColumnField[] = DIAGNOSTIC_SENSOR_FIELDS;
void _sensorFieldsAreColumns;
