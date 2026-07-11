import { describe, expect, it } from "vitest";
import { FRAME_PARQUET_COLUMNS, INGEST_LIMITS } from "@heimdall/shared";
import { validateFrameParquetMetadata } from "../parquet/frame-metadata";

function metadata(
  rowCount: bigint,
  rowGroupCounts: bigint[] = [rowCount],
  uncompressedSize = 1n,
) {
  return {
    num_rows: rowCount,
    row_groups: rowGroupCounts.map((num_rows) => ({
      num_rows,
      total_byte_size: 0n,
      columns: FRAME_PARQUET_COLUMNS.map((column) =>
        ({
          meta_data: {
            path_in_schema: [column.name],
            type: column.type,
            num_values: num_rows,
            total_uncompressed_size: uncompressedSize,
          },
        }) as never,
      ),
    })),
  };
}

describe("validateFrameParquetMetadata", () => {
  it.each([
    BigInt(INGEST_LIMITS.minFramesPerRun - 1),
    BigInt(INGEST_LIMITS.maxFramesPerRun + 1),
  ])("rejects an out-of-range metadata row count before row decoding: %s", (rowCount) => {
    expect(() => validateFrameParquetMetadata(metadata(rowCount))).toThrow(/outside ingest limits/);
  });

  it("rejects metadata whose row groups disagree with the declared total", () => {
    expect(() => validateFrameParquetMetadata(metadata(16n, [8n, 7n]))).toThrow(/disagrees with row groups/);
  });

  it("returns the declared count once it is safe to materialize", () => {
    expect(validateFrameParquetMetadata(metadata(16n, [4n, 12n]))).toBe(16);
  });

  it("rejects oversized physical frame columns before decoding", () => {
    expect(() =>
      validateFrameParquetMetadata(metadata(16n, [16n], BigInt(INGEST_LIMITS.maxParquetBytes))),
    ).toThrow(/decoded-byte limit/);
  });
});
