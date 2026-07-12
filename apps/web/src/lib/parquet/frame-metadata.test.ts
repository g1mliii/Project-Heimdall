import { describe, expect, it } from "vitest";
import { parquetWriteBuffer } from "hyparquet-writer";
import { framesToColumnData, validFrames } from "@heimdall/shared";

import { validateFrameParquetSensorValues } from "./frame-metadata";

function parquetBytes(frames = validFrames): ArrayBuffer {
  return parquetWriteBuffer({ columnData: framesToColumnData(frames) });
}

describe("validateFrameParquetSensorValues", () => {
  it("accepts valid optional sensor values", async () => {
    await expect(validateFrameParquetSensorValues(parquetBytes())).resolves.toBeUndefined();
  });

  it("rejects an out-of-range optional sensor value", async () => {
    const invalidFrames = validFrames.map((frame, index) =>
      index === 0 ? { ...frame, gpuLoadPct: 101 } : frame,
    );

    await expect(validateFrameParquetSensorValues(parquetBytes(invalidFrames))).rejects.toThrow(
      /gpu_load_pct/,
    );
  });
});
