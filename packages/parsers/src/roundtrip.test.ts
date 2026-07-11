import { describe, expect, it } from "vitest";
import type { FrameSample } from "@heimdall/shared";

import { parseCapFrameX } from "./capframex";
import { parsePresentMon } from "./presentmon";
import { parseMangoHud } from "./mangohud";
import type { SensorColumnField } from "./internal/columns";
import {
  serializeCapFrameXCsv,
  serializeMangoHudLog,
  serializePresentMonV2Csv,
} from "./testing/serializers";
import { expectClose } from "./testing/assertions";
import { makeLcg } from "./testing/rng";

/** Sensor value generators, kept inside each field's plausibility guard. */
const SENSOR_RANGES: Record<SensorColumnField, (r: number) => number> = {
  gpuLoadPct: (r) => r * 100,
  gpuClockMhz: (r) => 300 + r * 2700,
  gpuPowerW: (r) => 5 + r * 400,
  vramUsedMb: (r) => r * 16384,
  cpuLoadPct: (r) => r * 100,
  cpuBusyMs: (r) => r * 20,
  gpuBusyMs: (r) => r * 20,
};

interface RoundTripCase {
  name: string;
  /** Fields this source's file format can carry. */
  fields: SensorColumnField[];
  serialize: (frames: readonly FrameSample[]) => string;
  parse: (input: string) => ReturnType<typeof parseCapFrameX>;
}

const CASES: RoundTripCase[] = [
  {
    name: "capframex csv",
    fields: ["gpuLoadPct", "gpuClockMhz", "gpuPowerW", "vramUsedMb", "cpuLoadPct", "gpuBusyMs"],
    serialize: serializeCapFrameXCsv,
    parse: parseCapFrameX,
  },
  {
    name: "presentmon v2 csv",
    fields: [
      "gpuLoadPct",
      "gpuClockMhz",
      "gpuPowerW",
      "vramUsedMb",
      "cpuBusyMs",
      "gpuBusyMs",
    ],
    serialize: serializePresentMonV2Csv,
    parse: parsePresentMon,
  },
  {
    name: "mangohud log",
    fields: ["gpuLoadPct", "gpuClockMhz", "gpuPowerW", "vramUsedMb", "cpuLoadPct"],
    serialize: serializeMangoHudLog,
    parse: parseMangoHud,
  },
];

describe("round-trip: parse(serialize(frames)) ≈ frames (seeded LCG)", () => {
  for (const testCase of CASES) {
    it(testCase.name, () => {
      const rand = makeLcg(0xc0ffee42);

      for (let iteration = 0; iteration < 25; iteration++) {
        // Which sensors this synthetic file carries at all.
        const presentFields = testCase.fields.filter(() => rand() < 0.7);

        const n = 1 + Math.floor(rand() * 100);
        let timeMs = 0;
        const frames: FrameSample[] = [];
        for (let i = 0; i < n; i++) {
          const frameTimeMs = 0.5 + rand() * 40;
          const frame: FrameSample = { timeMs, frameTimeMs };
          for (const field of presentFields) {
            if (rand() < 0.9) frame[field] = SENSOR_RANGES[field](rand());
          }
          frames.push(frame);
          timeMs += frameTimeMs;
        }

        const result = testCase.parse(testCase.serialize(frames));
        expect(result.ok, `${testCase.name} iteration ${iteration}`).toBe(true);
        if (result.ok) {
          expectClose(result.value.frames, frames, `${testCase.name}[${iteration}]`);
        }
      }
    });
  }
});
