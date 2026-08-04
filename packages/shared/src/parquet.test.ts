import { describe, expect, it } from "vitest";

import {
  FRAME_PARQUET_COLUMNS,
  PRESENT_FRAME_TYPE,
  framesToColumnData,
  presentFrameTypeCode,
  rowsToFrameSamples,
} from "./parquet";
import { MIN_FRAME_TIME_MS } from "./constants";
import { frameSampleSchema } from "./schemas";
import { validFrames, missingSensorFrames } from "./fixtures";
import type { FrameSample } from "./types";

/** Simulate a reader: transpose column data back into row objects. */
function columnsToRows(columns: ReturnType<typeof framesToColumnData>) {
  const rowCount = columns[0]?.data.length ?? 0;
  return Array.from({ length: rowCount }, (_, i) =>
    Object.fromEntries(columns.map((c) => [c.name, c.data[i]])),
  );
}

describe("frame parquet column contract", () => {
  it("covers every FrameSample field exactly once", () => {
    const fields = FRAME_PARQUET_COLUMNS.map((c) => c.field);
    expect(new Set(fields).size).toBe(fields.length);
    // A fully populated fixture frame has no field the columns don't carry.
    const frame = validFrames[0]!;
    for (const key of Object.keys(frame) as (keyof FrameSample)[]) {
      expect(fields, `column missing for FrameSample.${key}`).toContain(key);
    }
    expect(fields.length).toBe(Object.keys(frame).length);
  });

  it("only core timing columns are non-nullable", () => {
    const required = FRAME_PARQUET_COLUMNS.filter((c) => !c.nullable).map((c) => c.name);
    expect(required.sort()).toEqual(["frame_time_ms", "time_ms"]);
  });

  it("round-trips sensor-complete frames bit-identically", () => {
    const back = rowsToFrameSamples(columnsToRows(framesToColumnData(validFrames)));
    expect(back).toEqual(validFrames);
  });

  it("round-trips sensor-sparse frames (nulls -> omitted optionals)", () => {
    const back = rowsToFrameSamples(columnsToRows(framesToColumnData(missingSensorFrames)));
    expect(back).toEqual(missingSensorFrames);
    // Every recovered frame is schema-clean.
    for (const frame of back) {
      expect(frameSampleSchema.safeParse(frame).success).toBe(true);
    }
  });

  it("rejects corrupt rows: missing, non-numeric, or non-positive core columns", () => {
    expect(() => rowsToFrameSamples([{ time_ms: 0 }])).toThrow(/frame_time_ms/);
    expect(() => rowsToFrameSamples([{ time_ms: 0, frame_time_ms: "8.3" }])).toThrow(
      /frame_time_ms/,
    );
    expect(() => rowsToFrameSamples([{ time_ms: 0, frame_time_ms: 0 }])).toThrow(/frame_time_ms/);
    expect(() =>
      rowsToFrameSamples([{ time_ms: 0, frame_time_ms: MIN_FRAME_TIME_MS / 10 }]),
    ).toThrow(/frame_time_ms/);
    expect(() => rowsToFrameSamples([{ time_ms: -1, frame_time_ms: 8.3 }])).toThrow(/>= 0/);
    expect(() => rowsToFrameSamples([{ time_ms: 0, frame_time_ms: Number.NaN }])).toThrow(
      /finite/,
    );
  });

  it("rejects a timestamp that moves backwards but permits equal timestamps", () => {
    expect(() =>
      rowsToFrameSamples([
        { time_ms: 0, frame_time_ms: 8.3 },
        { time_ms: 8.3, frame_time_ms: 8.3 },
        { time_ms: 8.2, frame_time_ms: 8.3 },
      ]),
    ).toThrow(/row 2: time_ms must not decrease/);
    expect(
      rowsToFrameSamples([
        { time_ms: 0, frame_time_ms: 8.3 },
        { time_ms: 0, frame_time_ms: 8.3 },
      ]),
    ).toHaveLength(2);
  });

  it("rejects out-of-range sensor values (load percent above 100)", () => {
    expect(() =>
      rowsToFrameSamples([{ time_ms: 0, frame_time_ms: 8.3, gpu_load_pct: 101 }]),
    ).toThrow(/gpu_load_pct/);
    expect(() =>
      rowsToFrameSamples([{ time_ms: 0, frame_time_ms: 8.3, cpu_busy_ms: -0.1 }]),
    ).toThrow(/cpu_busy_ms/);
    expect(() =>
      rowsToFrameSamples([{ time_ms: 0, frame_time_ms: 8.3, generated: "yes" }]),
    ).toThrow(/generated/);
  });

  it("reports the failing row index", () => {
    const rows = [
      { time_ms: 0, frame_time_ms: 8.3 },
      { time_ms: 8.3, frame_time_ms: -2 },
    ];
    expect(() => rowsToFrameSamples(rows)).toThrow(/row 1/);
  });
});

describe("presentFrameTypeCode (§22.12)", () => {
  it("keeps `unknown` distinct from `rendered`", () => {
    // The distinction the whole phase rests on: a present nobody labelled is
    // NOT a rendered present. Collapsing the two would let the coalescer open
    // an interval on evidence that does not exist.
    expect(presentFrameTypeCode(undefined)).toBe(PRESENT_FRAME_TYPE.unknown);
    expect(presentFrameTypeCode(false)).toBe(PRESENT_FRAME_TYPE.rendered);
    expect(presentFrameTypeCode(true)).toBe(PRESENT_FRAME_TYPE.generated);
  });

  it("produces codes that fit a Uint8Array without truncation", () => {
    // The column is stored one byte per row for up to 500k rows; a code above
    // 255 would silently wrap.
    const codes = Object.values(PRESENT_FRAME_TYPE);
    for (const code of codes) {
      expect(Number.isInteger(code)).toBe(true);
      expect(code).toBeGreaterThanOrEqual(0);
      expect(code).toBeLessThanOrEqual(255);
    }
    expect(new Set(codes).size).toBe(codes.length);
  });
});
