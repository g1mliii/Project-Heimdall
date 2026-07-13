/**
 * Frame Parquet column contract (Phase 4 §11.1).
 *
 * Single source of truth for the columnar layout of the per-frame Parquet blob
 * in R2, shared by the browser writer (hyparquet-writer) and the server reader
 * (hyparquet) so the two can never drift. Deliberately DOUBLE/BOOLEAN only — no
 * INT64 — so readers never surface BigInt and float64 values round-trip
 * bit-identically, which is what makes the §11.5 server recompute genuinely
 * comparable to the client's summary.
 *
 * Pure and dependency-free: the parquet libraries themselves live in apps/web.
 */

import { MIN_FRAME_TIME_MS } from "./constants";
import type { FrameSample } from "./types";

/** Bump when the column layout changes incompatibly (mirrors §2.2 versioning). */
export const FRAMES_PARQUET_SCHEMA_VERSION = 1;

/** Content type both the browser PUT and the R2 helpers use. */
export const PARQUET_CONTENT_TYPE = "application/vnd.apache.parquet";

interface FrameParquetColumn {
  /** Parquet column name (snake_case on the wire). */
  name: string;
  /** Physical Parquet type — the only two we allow. */
  type: "DOUBLE" | "BOOLEAN";
  /** Optional sensor columns are nullable; core timing columns are not. */
  nullable: boolean;
  /** The FrameSample field this column carries. */
  field: keyof FrameSample;
}

export const FRAME_PARQUET_COLUMNS: readonly FrameParquetColumn[] = [
  { name: "time_ms", type: "DOUBLE", nullable: false, field: "timeMs" },
  { name: "frame_time_ms", type: "DOUBLE", nullable: false, field: "frameTimeMs" },
  { name: "generated", type: "BOOLEAN", nullable: true, field: "generated" },
  { name: "gpu_load_pct", type: "DOUBLE", nullable: true, field: "gpuLoadPct" },
  { name: "gpu_clock_mhz", type: "DOUBLE", nullable: true, field: "gpuClockMhz" },
  { name: "gpu_power_w", type: "DOUBLE", nullable: true, field: "gpuPowerW" },
  { name: "vram_used_mb", type: "DOUBLE", nullable: true, field: "vramUsedMb" },
  { name: "cpu_load_pct", type: "DOUBLE", nullable: true, field: "cpuLoadPct" },
  { name: "cpu_busy_ms", type: "DOUBLE", nullable: true, field: "cpuBusyMs" },
  { name: "gpu_busy_ms", type: "DOUBLE", nullable: true, field: "gpuBusyMs" },
] as const;

/**
 * Sensor fields retained by the diagnostics engine. The Phase 6 rules use the
 * utilization/VRAM trio; the Phase 6.5 confidence-graded rules add the verified
 * busy-time columns (`cpuBusyMs`/`gpuBusyMs`), so the columnar diagnostics path
 * must retain them too (§16b). These already exist in the v1 Parquet schema, so
 * no schema bump is needed.
 */
export const DIAGNOSTIC_FRAME_SENSOR_FIELDS = [
  "vramUsedMb",
  "gpuLoadPct",
  "cpuLoadPct",
  "cpuBusyMs",
  "gpuBusyMs",
] as const;
export type DiagnosticFrameSensorField = (typeof DIAGNOSTIC_FRAME_SENSOR_FIELDS)[number];

/** The on-wire columns that back the diagnostics sensor contract. */
export const DIAGNOSTIC_FRAME_PARQUET_COLUMNS = FRAME_PARQUET_COLUMNS.filter(
  (column): column is FrameParquetColumn & { field: DiagnosticFrameSensorField } =>
    (DIAGNOSTIC_FRAME_SENSOR_FIELDS as readonly string[]).includes(column.field),
);

/** Column-source shape consumed by hyparquet-writer's `parquetWriteBuffer`. */
export interface FrameColumnData {
  name: string;
  data: (number | boolean | null)[];
  type: "DOUBLE" | "BOOLEAN";
  nullable: boolean;
}

/**
 * Transpose frames into hyparquet-writer column sources. Missing optional
 * sensor values become nulls (the column still exists, so readers see a stable
 * schema regardless of which sensors a capture source reported).
 */
export function framesToColumnData(frames: readonly FrameSample[]): FrameColumnData[] {
  return FRAME_PARQUET_COLUMNS.map((column) => ({
    name: column.name,
    data: frames.map((frame) => frame[column.field] ?? null),
    type: column.type,
    nullable: column.nullable,
  }));
}

/**
 * Map rows read back from the Parquet (hyparquet `parquetReadObjects` output)
 * into validated FrameSamples. Mirrors `frameSampleSchema` semantics but stays
 * a hand-rolled loop: the verification worker feeds it whole captures (up to
 * INGEST_LIMITS.maxFramesPerRun rows), where per-row zod parsing is measurably
 * slower for no extra safety.
 *
 * Throws on the first invalid row — the stored object is either corrupt or not
 * one of ours, and the caller (§11.5 worker) must treat that as terminal.
 */
export function rowsToFrameSamples(rows: readonly Record<string, unknown>[]): FrameSample[] {
  let previousTimeMs: number | undefined;
  return rows.map((row, index) => {
    const timeMs = parseFrameParquetTimeMs(row["time_ms"], index);
    const frameTimeMs = parseFrameParquetFrameTimeMs(row["frame_time_ms"], index);
    assertFrameParquetTimeOrder(previousTimeMs, timeMs, index);
    previousTimeMs = timeMs;
    const frame: FrameSample = { timeMs, frameTimeMs };
    const generated = parseOptionalFrameParquetGenerated(row["generated"], index);
    if (generated !== undefined) frame.generated = generated;
    setOptional(frame, "gpuLoadPct", row, "gpu_load_pct", index);
    setOptional(frame, "gpuClockMhz", row, "gpu_clock_mhz", index);
    setOptional(frame, "gpuPowerW", row, "gpu_power_w", index);
    setOptional(frame, "vramUsedMb", row, "vram_used_mb", index);
    setOptional(frame, "cpuLoadPct", row, "cpu_load_pct", index);
    setOptional(frame, "cpuBusyMs", row, "cpu_busy_ms", index);
    setOptional(frame, "gpuBusyMs", row, "gpu_busy_ms", index);
    return frame;
  });
}

/** Validate one required frame timestamp from a frame-Parquet row or chunk. */
export function parseFrameParquetTimeMs(value: unknown, index: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`parquet row ${index}: time_ms must be a finite number, got ${String(value)}`);
  }
  if (value < 0) {
    throw new Error(`parquet row ${index}: time_ms must be >= 0, got ${value}`);
  }
  return value;
}

/** Validate one required frame duration from a frame-Parquet row or chunk. */
export function parseFrameParquetFrameTimeMs(value: unknown, index: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`parquet row ${index}: frame_time_ms must be a finite number, got ${String(value)}`);
  }
  if (value < MIN_FRAME_TIME_MS) {
    throw new Error(
      `parquet row ${index}: frame_time_ms must be >= ${MIN_FRAME_TIME_MS}, got ${value}`,
    );
  }
  return value;
}

/** Preserve the storage contract that frame timestamps never decrease. */
export function assertFrameParquetTimeOrder(
  previousTimeMs: number | undefined,
  timeMs: number,
  index: number,
): void {
  if (previousTimeMs !== undefined && timeMs < previousTimeMs) {
    throw new Error(
      `parquet row ${index}: time_ms must not decrease (previous ${previousTimeMs}, got ${timeMs})`,
    );
  }
}

/** Validate the nullable generated-frame flag from a frame-Parquet row or chunk. */
export function parseOptionalFrameParquetGenerated(
  value: unknown,
  index: number,
): boolean | undefined {
  if (value === null || value === undefined) return undefined;
  if (typeof value !== "boolean") {
    throw new Error(`parquet row ${index}: generated must be boolean`);
  }
  return value;
}

/** Validate one nullable numeric sensor value from a frame-Parquet column. */
export function parseOptionalFrameParquetNumber(
  name: string,
  value: unknown,
  index: number,
): number | undefined {
  if (value === null || value === undefined) {
    return undefined;
  }
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error(`parquet row ${index}: ${name} must be a finite number >= 0`);
  }
  if ((name === "gpu_load_pct" || name === "cpu_load_pct") && value > 100) {
    throw new Error(`parquet row ${index}: ${name} must be <= 100, got ${value}`);
  }
  return value;
}

function setOptional(
  frame: FrameSample,
  field: Exclude<keyof FrameSample, "timeMs" | "frameTimeMs" | "generated">,
  row: Record<string, unknown>,
  name: string,
  index: number,
): void {
  const value = parseOptionalFrameParquetNumber(name, row[name], index);
  if (value !== undefined) frame[field] = value;
}
