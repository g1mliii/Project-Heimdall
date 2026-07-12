import { Buffer } from "node:buffer";
import { describe, expect, it, vi } from "vitest";

vi.mock("hyparquet", async (importOriginal) => {
  const actual = await importOriginal<typeof import("hyparquet")>();
  return {
    ...actual,
    parquetRead: vi.fn(actual.parquetRead),
    parquetReadObjects: vi.fn(actual.parquetReadObjects),
  };
});

import { parquetRead, parquetReadObjects } from "hyparquet";
import { parquetWriteBuffer } from "hyparquet-writer";
import { computeRunSummary } from "@heimdall/parsers";
import { framesToColumnData, makeSyntheticFrames, missingSensorFrames, validFrames } from "@heimdall/shared";
import { buildFrameSeries } from "../run/frame-series";

import {
  computeFrameParquetSummary,
  decodeFrameParquetToSeries,
  FRAME_CHART_PARQUET_COLUMN_NAMES,
  FRAME_PARQUET_COLUMN_NAMES,
} from "./frame-metadata";

function parquetBytes(frames = validFrames): ArrayBuffer {
  return parquetWriteBuffer({ columnData: framesToColumnData(frames) });
}

describe("computeFrameParquetSummary", () => {
  it("streams one schema column at a time without materializing row objects", async () => {
    const readChunks = vi.mocked(parquetRead);
    const readObjects = vi.mocked(parquetReadObjects);
    readChunks.mockClear();
    readObjects.mockClear();

    await expect(computeFrameParquetSummary(parquetBytes())).resolves.toEqual(
      computeRunSummary(validFrames),
    );

    expect(readChunks).toHaveBeenCalledTimes(FRAME_PARQUET_COLUMN_NAMES.length);
    for (const [index, columnName] of FRAME_PARQUET_COLUMN_NAMES.entries()) {
      expect(readChunks).toHaveBeenNthCalledWith(
        index + 1,
        expect.objectContaining({ columns: [columnName], onChunk: expect.any(Function) }),
      );
    }
    expect(readObjects).not.toHaveBeenCalled();
  });

  it("rejects an out-of-range optional sensor value", async () => {
    const invalidFrames = validFrames.map((frame, index) =>
      index === 0 ? { ...frame, gpuLoadPct: 101 } : frame,
    );

    await expect(computeFrameParquetSummary(parquetBytes(invalidFrames))).rejects.toThrow(
      /gpu_load_pct/,
    );
  });

  it("accepts a Parquet view with an offset into a larger backing buffer", async () => {
    const bytes = new Uint8Array(parquetBytes());
    const padded = new Uint8Array(bytes.byteLength + 2);
    padded.set(bytes, 1);
    const view = Buffer.from(padded.buffer, 1, bytes.byteLength);

    await expect(computeFrameParquetSummary(view)).resolves.toEqual(computeRunSummary(validFrames));
  });

  it("matches the canonical frame-object summary over varied valid captures", async () => {
    for (let seed = 1; seed <= 40; seed++) {
      const frames = makeSyntheticFrames({
        seed,
        count: 10 + ((seed * 7919) % 500),
      });
      await expect(computeFrameParquetSummary(parquetBytes(frames))).resolves.toEqual(
        computeRunSummary(frames),
      );
    }
  });
});

describe("decodeFrameParquetToSeries", () => {
  it("streams only the chart projection into typed columns", async () => {
    const readChunks = vi.mocked(parquetRead);
    const readObjects = vi.mocked(parquetReadObjects);
    readChunks.mockClear();
    readObjects.mockClear();

    const series = await decodeFrameParquetToSeries(parquetBytes());
    const expected = buildFrameSeries(validFrames);

    expect(series.count).toBe(validFrames.length);
    expect(Array.from(series.times)).toEqual(Array.from(expected.times));
    expect(Array.from(series.frameTimes)).toEqual(validFrames.map((frame) => frame.frameTimeMs));
    expect(readChunks).toHaveBeenCalledTimes(FRAME_CHART_PARQUET_COLUMN_NAMES.length);
    expect(readChunks.mock.calls.map(([options]) => options.columns)).toEqual(
      FRAME_CHART_PARQUET_COLUMN_NAMES.map((column) => [column]),
    );
    expect(readObjects).not.toHaveBeenCalled();
  });

  it("handles absent and mixed optional chart sensors", async () => {
    const withoutSensors = await decodeFrameParquetToSeries(parquetBytes(missingSensorFrames));
    expect(withoutSensors.avgGpuLoadPct).toBeUndefined();
    expect(withoutSensors.peakVramUsedMb).toBeUndefined();

    const mixedSensors = validFrames.map((frame, index) =>
      index % 2 === 0 ? { ...frame, gpuLoadPct: undefined, vramUsedMb: undefined } : frame,
    );
    const mixedSeries = await decodeFrameParquetToSeries(parquetBytes(mixedSensors));
    const presentSensors = mixedSensors.filter(
      (frame): frame is typeof frame & { gpuLoadPct: number; vramUsedMb: number } =>
        frame.gpuLoadPct !== undefined && frame.vramUsedMb !== undefined,
    );

    expect(mixedSeries.avgGpuLoadPct).toBeCloseTo(
      presentSensors.reduce((sum, frame) => sum + frame.gpuLoadPct, 0) / presentSensors.length,
    );
    expect(mixedSeries.peakVramUsedMb).toBe(Math.max(...presentSensors.map((frame) => frame.vramUsedMb)));
  });
});
