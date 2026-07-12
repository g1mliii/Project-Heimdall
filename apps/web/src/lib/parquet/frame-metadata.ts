/**
 * Browser-safe Parquet metadata guard shared by the verification worker and
 * the run-page reader. It validates before either path materializes rows.
 */

import type { FileMetaData } from "hyparquet";
import {
  FRAME_PARQUET_COLUMNS,
  INGEST_LIMITS,
  assertFrameParquetTimeOrder,
  parseFrameParquetFrameTimeMs,
  parseFrameParquetTimeMs,
  parseOptionalFrameParquetGenerated,
  parseOptionalFrameParquetNumber,
  rowsToFrameSamples,
} from "@heimdall/shared";
import type { FrameSample, RunSummary } from "@heimdall/shared";

export const FRAME_PARQUET_COLUMN_NAMES = FRAME_PARQUET_COLUMNS.map((column) => column.name);
/** Columns needed to render the Phase 5 chart and hardware summary. */
export const FRAME_CHART_PARQUET_COLUMN_NAMES = [
  "time_ms",
  "frame_time_ms",
  "gpu_load_pct",
  "vram_used_mb",
];
const MAX_DECODED_FRAME_PARQUET_BYTES = BigInt(INGEST_LIMITS.maxParquetBytes);

interface FrameParquetChunk {
  columnName: string;
  columnData: ArrayLike<unknown>;
  rowStart: number;
  rowEnd: number;
}

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
 * Validate every persisted frame column while retaining only the scalar data
 * needed for the canonical summary. Columns decode one at a time because
 * hyparquet starts all requested columns concurrently; this keeps verification
 * bounded by the Parquet bytes, two Float64Arrays, and one temporary presence
 * bitmap instead of a full object graph (or every decoded column) for up to
 * 500,000 FrameSample rows.
 */
export async function computeFrameParquetSummary(
  input: ArrayBuffer | Uint8Array,
): Promise<RunSummary> {
  const { parquetMetadata, parquetRead } = await import("hyparquet");
  const buffer = asArrayBuffer(input);
  const metadata = parquetMetadata(buffer);
  const frameCount = validateFrameParquetMetadata(metadata);
  let times: Float64Array | undefined = new Float64Array(frameCount);
  const frameTimes = new Float64Array(frameCount);
  let generatedFrameCount = 0;

  for (const expectedColumnName of FRAME_PARQUET_COLUMN_NAMES) {
    // A single-column pass lets each decoded column become collectible before
    // the next starts. Keep one compact presence map because row groups may
    // complete out of order; count + no duplicates proves full coverage.
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
          const value = columnData[offset];
          if (seenRows[row] !== 0) {
            recordError(`parquet column ${columnName} repeats row ${row}`);
            return;
          }
          seenRows[row] = 1;
          if (columnName === "time_ms") {
            times![row] = parseFrameParquetTimeMs(value, row);
            continue;
          }
          if (columnName === "frame_time_ms") {
            frameTimes[row] = parseFrameParquetFrameTimeMs(value, row);
            continue;
          }
          if (columnName === "generated") {
            if (parseOptionalFrameParquetGenerated(value, row) === true) generatedFrameCount++;
            continue;
          }
          parseOptionalFrameParquetNumber(columnName, value, row);
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
  return computeRunSummaryFromFrameTimes(frameTimes, generatedFrameCount);
}

/**
 * The single frame-Parquet decode path, shared by the run-page reader (client)
 * and verification worker (server): both fully validate the stored layout. The
 * browser explicitly requests the chart projection; the worker uses
 * `computeFrameParquetSummary()` to avoid object materialization. `hyparquet`
 * is dynamic-imported so it stays off non-run client bundles. Throws on any
 * layout, size, or row-count violation — callers decide how to surface it.
 */
export async function decodeFrameParquet(
  buffer: ArrayBuffer,
  columns: string[] = FRAME_PARQUET_COLUMN_NAMES,
): Promise<FrameSample[]> {
  const { parquetMetadata, parquetReadObjects } = await import("hyparquet");
  const metadata = parquetMetadata(buffer);
  const frameCount = validateFrameParquetMetadata(metadata);
  const rows = await parquetReadObjects({
    file: buffer,
    metadata,
    columns,
    rowEnd: frameCount,
  });
  if (rows.length !== frameCount) {
    throw new Error(`decoded ${rows.length} frames but metadata declared ${frameCount}`);
  }
  return rowsToFrameSamples(rows);
}
