/**
 * Browser-safe Parquet metadata guard shared by the verification worker and
 * the run-page reader. It validates before either path materializes rows.
 */

import type { FileMetaData } from "hyparquet";
import { FRAME_PARQUET_COLUMNS, INGEST_LIMITS, rowsToFrameSamples } from "@heimdall/shared";
import type { FrameSample } from "@heimdall/shared";

export const FRAME_PARQUET_COLUMN_NAMES = FRAME_PARQUET_COLUMNS.map((column) => column.name);
/** Columns needed to render the Phase 5 chart and hardware summary. */
export const FRAME_CHART_PARQUET_COLUMN_NAMES = [
  "time_ms",
  "frame_time_ms",
  "gpu_load_pct",
  "vram_used_mb",
];
/** Columns needed by the canonical summary recompute. */
export const FRAME_VERIFICATION_PARQUET_COLUMN_NAMES = ["time_ms", "frame_time_ms", "generated"];
const MAX_DECODED_FRAME_PARQUET_BYTES = BigInt(INGEST_LIMITS.maxParquetBytes);

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
 * The single frame-Parquet decode path, shared by the run-page reader (client)
 * and verification worker (server): both fully validate the stored layout,
 * then materialize only the columns their consumer needs. `hyparquet` is
 * dynamic-imported so it stays off non-run client bundles. Throws on any
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
