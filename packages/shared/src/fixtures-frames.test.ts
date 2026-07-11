import { describe, expect, it } from "vitest";

import { MIN_FRAME_TIME_MS, STUTTER } from "./constants";
import {
  SYNTHETIC_GENERATED_FRACTION,
  SYNTHETIC_SPIKE_COUNT,
  makeSyntheticFrames,
  syntheticRunBase,
} from "./fixtures-frames";
import { frameSampleSchema } from "./schemas";

describe("makeSyntheticFrames", () => {
  it("is deterministic: same options produce identical frames", () => {
    expect(makeSyntheticFrames({ seed: 7, count: 500 })).toEqual(
      makeSyntheticFrames({ seed: 7, count: 500 }),
    );
  });

  it("varies with the seed", () => {
    expect(makeSyntheticFrames({ seed: 7, count: 500 })).not.toEqual(
      makeSyntheticFrames({ seed: 8, count: 500 }),
    );
  });

  it("produces schema-valid frames with strictly increasing timestamps", () => {
    const frames = makeSyntheticFrames({ count: 1000 });
    expect(frames).toHaveLength(1000);
    let prev = -1;
    for (const frame of frames) {
      expect(frameSampleSchema.safeParse(frame).success).toBe(true);
      expect(frame.timeMs).toBeGreaterThan(prev);
      expect(frame.frameTimeMs).toBeGreaterThanOrEqual(MIN_FRAME_TIME_MS);
      prev = frame.timeMs;
    }
  });

  it("injects exactly SYNTHETIC_SPIKE_COUNT frames satisfying the STUTTER rule", () => {
    const frames = makeSyntheticFrames({ count: 7200 });
    const sorted = frames.map((f) => f.frameTimeMs).sort((a, b) => a - b);
    const median = sorted[Math.ceil(sorted.length / 2) - 1]!;
    const stutters = frames.filter(
      (f) =>
        f.frameTimeMs > STUTTER.medianMultiplier * median &&
        f.frameTimeMs > STUTTER.minFrameTimeMs,
    );
    expect(stutters).toHaveLength(SYNTHETIC_SPIKE_COUNT);
  });

  it("flags exactly the generated fraction when count is divisible by 5", () => {
    const frames = makeSyntheticFrames({ count: 500 });
    const generated = frames.filter((f) => f.generated === true).length;
    expect(generated / frames.length).toBe(SYNTHETIC_GENERATED_FRACTION);
  });

  it("carries full sensor columns including a rising VRAM ramp", () => {
    const frames = makeSyntheticFrames({ count: 1000 });
    for (const frame of frames) {
      expect(frame.gpuLoadPct).toBeTypeOf("number");
      expect(frame.vramUsedMb).toBeTypeOf("number");
      expect(frame.cpuLoadPct).toBeTypeOf("number");
      expect(frame.gpuBusyMs).toBeTypeOf("number");
    }
    expect(frames[frames.length - 1]!.vramUsedMb!).toBeGreaterThan(frames[0]!.vramUsedMb! + 2000);
  });
});

describe("syntheticRunBase", () => {
  it("exercises the frame-gen badge and the RAM warn row", () => {
    expect(syntheticRunBase.generatedFrameTech).toBe("dlss3");
    expect(syntheticRunBase.hardware.ramSpeedMtps!).toBeLessThan(
      syntheticRunBase.hardware.ramRatedSpeedMtps!,
    );
  });
});
