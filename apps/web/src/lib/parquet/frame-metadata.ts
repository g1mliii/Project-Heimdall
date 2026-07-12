/**
 * Browser-safe Parquet metadata guard shared by the verification worker and
 * the run-page reader. It validates before either path materializes rows.
 */

import type { FileMetaData } from "hyparquet";
import {
  DIAGNOSTIC_FRAME_PARQUET_COLUMNS,
  DIAGNOSTIC_FRAME_SENSOR_FIELDS,
  FRAME_PARQUET_COLUMNS,
  INGEST_LIMITS,
  assertFrameParquetTimeOrder,
  parseFrameParquetFrameTimeMs,
  parseFrameParquetTimeMs,
  parseOptionalFrameParquetGenerated,
  parseOptionalFrameParquetNumber,
} from "@heimdall/shared";
import type { RunSummary } from "@heimdall/shared";
import type { DiagnosticFrameSensorField } from "@heimdall/shared";
import type { DiagnosticsFrameColumns } from "@heimdall/parsers";
import { buildFrameSeriesFromColumns, type FrameSeries } from "../run/frame-series";

export const FRAME_PARQUET_COLUMN_NAMES = FRAME_PARQUET_COLUMNS.map((column) => column.name);
/** Columns needed to render the Phase 5 chart and hardware summary. */
export const FRAME_CHART_PARQUET_COLUMN_NAMES = [
  "time_ms",
  "frame_time_ms",
  "gpu_load_pct",
  "vram_used_mb",
] as const;
const [TIME_MS_COLUMN, FRAME_TIME_MS_COLUMN, GPU_LOAD_PCT_COLUMN, VRAM_USED_MB_COLUMN] =
  FRAME_CHART_PARQUET_COLUMN_NAMES;
const MAX_DECODED_FRAME_PARQUET_BYTES = BigInt(INGEST_LIMITS.maxParquetBytes);

interface FrameParquetChunk {
  columnName: string;
  columnData: ArrayLike<unknown>;
  rowStart: number;
  rowEnd: number;
}

type ParquetRead = typeof import("hyparquet").parquetRead;

function asArrayBuffer(input: ArrayBuffer | Uint8Array): ArrayBuffer {
  if (input instanceof ArrayBuffer) return input;
  if (
    input.byteOffset === 0 &&
    input.byteLength === input.buffer.byteLength &&
    input.buffer instanceof ArrayBuffer
  ) {
    return input.buffer;
  }
  if (input.buffer instanceof ArrayBuffer) {
    return input.buffer.slice(input.byteOffset, input.byteOffset + input.byteLength);
  }
  return Uint8Array.from(input).buffer;
}

/** Reject oversized or internally inconsistent captures before decoding rows. */
export function frameCountFromMetadata(
  metadata: Pick<FileMetaData, "num_rows" | "row_groups">,
): number {
  const rowCount = metadata.num_rows;
  const min = BigInt(INGEST_LIMITS.minFramesPerRun);
  const max = BigInt(INGEST_LIMITS.maxFramesPerRun);
  if (rowCount < min || rowCount > max) {
    throw new Error(`frame count ${rowCount} outside ingest limits`);
  }
  const rowGroupCount = metadata.row_groups.reduce((total, group) => total + group.num_rows, 0n);
  if (rowCount !== rowGroupCount) {
    throw new Error(`parquet metadata row count ${rowCount} disagrees with row groups ${rowGroupCount}`);
  }
  return Number(rowCount);
}

/** Reject malformed physical frame columns before the reader decodes page data. */
export function validateFrameParquetMetadata(
  metadata: Pick<FileMetaData, "num_rows" | "row_groups">,
): number {
  const frameCount = frameCountFromMetadata(metadata);
  let uncompressedBytes = 0n;
  for (const rowGroup of metadata.row_groups) {
    const columns = new Map(
      rowGroup.columns.flatMap((chunk) =>
        chunk.meta_data ? [[chunk.meta_data.path_in_schema[0], chunk.meta_data] as const] : [],
      ),
    );
    for (const frameColumn of FRAME_PARQUET_COLUMNS) {
      const column = columns.get(frameColumn.name);
      if (!column) {
        throw new Error(`parquet is missing required column ${frameColumn.name}`);
      }
      if (column.type !== frameColumn.type || column.num_values !== rowGroup.num_rows) {
        throw new Error(`parquet column ${frameColumn.name} has an invalid physical layout`);
      }
      uncompressedBytes += column.total_uncompressed_size;
      if (uncompressedBytes > MAX_DECODED_FRAME_PARQUET_BYTES) {
        throw new Error(`parquet frame columns exceed decoded-byte limit ${MAX_DECODED_FRAME_PARQUET_BYTES}`);
      }
    }
  }
  return frameCount;
}

/**
 * Decode and validate one column at a time. Besides keeping the peak heap
 * bounded, the presence bitmap proves that unordered row groups yielded each
 * row exactly once before a caller trusts the typed output buffer.
 */
async function readFrameParquetColumn(
  parquetRead: ParquetRead,
  buffer: ArrayBuffer,
  metadata: FileMetaData,
  frameCount: number,
  expectedColumnName: string,
  onValue: (value: unknown, row: number) => void,
): Promise<void> {
  const seenRows = new Uint8Array(frameCount);
  let observedRows = 0;
  let validationError: Error | undefined;

  const recordError = (message: string): void => {
    validationError ??= new Error(message);
  };

  const validateChunk = ({ columnName, columnData, rowStart, rowEnd }: FrameParquetChunk): void => {
    if (validationError) return;
    try {
      const expectedRows = rowEnd - rowStart;
      if (
        columnName !== expectedColumnName ||
        !Number.isInteger(rowStart) ||
        !Number.isInteger(rowEnd) ||
        rowStart < 0 ||
        rowEnd > frameCount ||
        expectedRows < 0 ||
        columnData.length !== expectedRows
      ) {
        recordError(`parquet column ${columnName} emitted an invalid row range`);
        return;
      }
      observedRows += expectedRows;

      for (let offset = 0; offset < expectedRows; offset++) {
        const row = rowStart + offset;
        if (seenRows[row] !== 0) {
          recordError(`parquet column ${columnName} repeats row ${row}`);
          return;
        }
        seenRows[row] = 1;
        onValue(columnData[offset], row);
      }
    } catch (error) {
      recordError(error instanceof Error ? error.message : String(error));
    }
  };

  await parquetRead({
    file: buffer,
    metadata,
    columns: [expectedColumnName],
    rowEnd: frameCount,
    onChunk: validateChunk,
  });

  if (validationError) throw validationError;
  if (observedRows !== frameCount) {
    throw new Error(`parquet column ${expectedColumnName} decoded an incomplete row range`);
  }
}

/** Sensor columns the diagnostics engine consumes (§15), derived from the shared Parquet contract. */
const DIAGNOSTICS_SENSOR_COLUMNS = new Map<string, DiagnosticFrameSensorField>(
  DIAGNOSTIC_FRAME_PARQUET_COLUMNS.map(({ name, field }) => [name, field]),
);

/**
 * Compact per-frame view for the diagnostics engine, retained alongside the
 * canonical summary during the single Parquet pass. `frameTimeMs` is always
 * present; a sensor column is present only when it carried ≥1 real value (an
 * absent sensor is dropped so its rules no-op, §15.5).
 */
export type FrameParquetDiagnosticsColumns = DiagnosticsFrameColumns &
  { frameTimeMs: Float64Array } &
  Partial<Record<DiagnosticFrameSensorField, Float64Array>>;

export interface FrameParquetSummary {
  summary: RunSummary;
  diagnosticsColumns: FrameParquetDiagnosticsColumns;
}

/**
 * Validate every persisted frame column while retaining only the scalar data
 * needed for the canonical summary AND the diagnostics engine. Columns decode
 * one at a time because hyparquet starts all requested columns concurrently;
 * this keeps verification bounded by the Parquet bytes and a handful of
 * Float64Arrays (frame times + the three diagnostics sensors) instead of a full
 * object graph for up to 500,000 FrameSample rows.
 */
export async function computeFrameParquetSummary(
  input: ArrayBuffer | Uint8Array,
): Promise<FrameParquetSummary> {
  const { parquetMetadata, parquetRead } = await import("hyparquet");
  const buffer = asArrayBuffer(input);
  const metadata = parquetMetadata(buffer);
  const frameCount = validateFrameParquetMetadata(metadata);
  let times: Float64Array | undefined = new Float64Array(frameCount);
  const frameTimes = new Float64Array(frameCount);
  let generatedFrameCount = 0;

  // Retained diagnostics sensor columns (NaN = value absent for that frame).
  // Allocate lazily: sensor-sparse captures should not pay 12 MiB for three
  // unused 500k-frame buffers.
  const sensorArrays: Partial<Record<DiagnosticFrameSensorField, Float64Array>> = {};

  for (const expectedColumnName of FRAME_PARQUET_COLUMN_NAMES) {
    await readFrameParquetColumn(
      parquetRead,
      buffer,
      metadata,
      frameCount,
      expectedColumnName,
      (value, row) => {
        if (expectedColumnName === "time_ms") {
          times![row] = parseFrameParquetTimeMs(value, row);
          return;
        }
        if (expectedColumnName === "frame_time_ms") {
          frameTimes[row] = parseFrameParquetFrameTimeMs(value, row);
          return;
        }
        if (expectedColumnName === "generated") {
          if (parseOptionalFrameParquetGenerated(value, row) === true) generatedFrameCount++;
          return;
        }
        const parsed = parseOptionalFrameParquetNumber(expectedColumnName, value, row);
        const field = DIAGNOSTICS_SENSOR_COLUMNS.get(expectedColumnName);
        if (field !== undefined && parsed !== undefined) {
          let sensorArray = sensorArrays[field];
          if (!sensorArray) {
            sensorArray = new Float64Array(frameCount).fill(NaN);
            sensorArrays[field] = sensorArray;
          }
          sensorArray[row] = parsed;
        }
      },
    );

    if (expectedColumnName === "time_ms") {
      let previousTimeMs: number | undefined;
      for (let row = 0; row < frameCount; row++) {
        const timeMs = times![row]!;
        assertFrameParquetTimeOrder(previousTimeMs, timeMs, row);
        previousTimeMs = timeMs;
      }
      // Timestamps are no longer needed after their monotonicity check. Drop
      // the 4 MiB maximum-size buffer before decoding the remaining sensors.
      times = undefined;
    }
  }
  // `frame-metadata` also ships to the run-page client. Keep the parser
  // dependency behind the worker-only path so downloading chart frames does
  // not pull the parser bundle into the browser.
  const { computeRunSummaryFromFrameTimes } = await import("@heimdall/parsers");
  const summary = computeRunSummaryFromFrameTimes(frameTimes, generatedFrameCount);

  const diagnosticsColumns: FrameParquetDiagnosticsColumns = { frameTimeMs: frameTimes };
  for (const field of DIAGNOSTIC_FRAME_SENSOR_FIELDS) {
    const sensorArray = sensorArrays[field];
    if (sensorArray) diagnosticsColumns[field] = sensorArray;
  }

  return { summary, diagnosticsColumns };
}

/**
 * Decode the run-page projection directly into the typed columns the chart
 * consumes. This deliberately never builds a `FrameSample[]`: a valid
 * 500,000-frame capture otherwise creates a large object graph immediately
 * before `buildFrameSeries` copies the same fields into typed arrays.
 */
export async function decodeFrameParquetToSeries(buffer: ArrayBuffer): Promise<FrameSeries> {
  const { parquetMetadata, parquetRead } = await import("hyparquet");
  const metadata = parquetMetadata(buffer);
  const frameCount = validateFrameParquetMetadata(metadata);

  const times = new Float64Array(frameCount);
  const frameTimes = new Float64Array(frameCount);
  let gpuLoadSum = 0;
  let gpuLoadCount = 0;
  let peakVramUsedMb: number | undefined;

  await readFrameParquetColumn(
    parquetRead,
    buffer,
    metadata,
    frameCount,
    TIME_MS_COLUMN,
    (value, row) => {
      times[row] = parseFrameParquetTimeMs(value, row);
    },
  );
  await readFrameParquetColumn(
    parquetRead,
    buffer,
    metadata,
    frameCount,
    FRAME_TIME_MS_COLUMN,
    (value, row) => {
      frameTimes[row] = parseFrameParquetFrameTimeMs(value, row);
    },
  );
  await readFrameParquetColumn(
    parquetRead,
    buffer,
    metadata,
    frameCount,
    GPU_LOAD_PCT_COLUMN,
    (value, row) => {
      const gpuLoadPct = parseOptionalFrameParquetNumber(GPU_LOAD_PCT_COLUMN, value, row);
      if (gpuLoadPct !== undefined) {
        gpuLoadSum += gpuLoadPct;
        gpuLoadCount++;
      }
    },
  );
  await readFrameParquetColumn(
    parquetRead,
    buffer,
    metadata,
    frameCount,
    VRAM_USED_MB_COLUMN,
    (value, row) => {
      const vramUsedMb = parseOptionalFrameParquetNumber(VRAM_USED_MB_COLUMN, value, row);
      if (vramUsedMb !== undefined && (peakVramUsedMb === undefined || vramUsedMb > peakVramUsedMb)) {
        peakVramUsedMb = vramUsedMb;
      }
    },
  );

  let previousTimeMs: number | undefined;
  for (let row = 0; row < frameCount; row++) {
    const timeMs = times[row]!;
    assertFrameParquetTimeOrder(previousTimeMs, timeMs, row);
    previousTimeMs = timeMs;
  }

  return buildFrameSeriesFromColumns(times, frameTimes, {
    ...(gpuLoadCount > 0 ? { avgGpuLoadPct: gpuLoadSum / gpuLoadCount } : {}),
    ...(peakVramUsedMb !== undefined ? { peakVramUsedMb } : {}),
  });
}
