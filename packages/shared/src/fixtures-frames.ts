/**
 * Deterministic synthetic frame streams for chart/UI tests (Phase 5 §14).
 *
 * The tiny hand-authored `validFrames` fixture (16 frames, no stutters) cannot
 * exercise a real chart: downsampling, stutter markers, and the visual
 * snapshot all need a capture-sized trace with known spikes. This generator
 * produces one from a seeded LCG so every call with the same options is
 * byte-identical — safe to bake into Playwright baselines.
 *
 * Summary values are deliberately NOT produced here: shared cannot depend on
 * `@heimdall/parsers`, and hand-authoring a summary would drift from the
 * canonical math. Callers run `computeRunSummary(frames)` themselves (the
 * parsers test suite pins generator↔summary parity).
 */

import { RUN_VISIBILITY, RUN_STATUS } from "./visibility";
import { CURRENT_SCHEMA_VERSION, STUTTER } from "./constants";
import type { FrameSample, Run } from "./types";

/** Same LCG as the design-kit mock charts — deterministic, seedable, fast. */
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

export interface MakeSyntheticFramesOptions {
  /** LCG seed; same seed → identical frames. */
  seed?: number;
  /** Frame count. Divisible by 5 keeps the generated share at exactly 40%. */
  count?: number;
  /** Baseline frame time in ms (~120 FPS by default, matching the design kit). */
  baseMs?: number;
}

/** Spikes injected per run — each one satisfies the shared STUTTER rule. */
export const SYNTHETIC_SPIKE_COUNT = 8;

/** Fraction of frames flagged `generated: true` (exact when count % 5 === 0). */
export const SYNTHETIC_GENERATED_FRACTION = 0.4;

/**
 * Build a deterministic ~`1000/baseMs` FPS frame stream with:
 * - jittered baseline frame times (±0.6 ms) with full sensor columns;
 * - a mid-run "rough patch" (+1.5–3.5 ms) that must NOT count as stutter;
 * - {@link SYNTHETIC_SPIKE_COUNT} spikes of 45–80 ms, each clearing both
 *   STUTTER conditions (> 2.5× median AND > minFrameTimeMs) by construction;
 * - `generated: true` on every 1st/2nd of 5 frames (40% — the DLSS3 story);
 * - a VRAM ramp (≈9000 → 11400 MB) so peak-VRAM UI has a real peak.
 */
export function makeSyntheticFrames(options: MakeSyntheticFramesOptions = {}): FrameSample[] {
  const { seed = 7, count = 7200, baseMs = 8.3 } = options;
  const rand = lcg(seed);

  // Evenly spread spike slots with jitter, clear of the first/last frames.
  const spikeAt = new Map<number, number>();
  for (let k = 0; k < SYNTHETIC_SPIKE_COUNT; k++) {
    const slot = Math.floor(((k + 0.5) * count) / SYNTHETIC_SPIKE_COUNT);
    const jitter = Math.floor((rand() - 0.5) * (count / SYNTHETIC_SPIKE_COUNT / 4));
    const index = Math.min(Math.max(slot + jitter, 1), count - 2);
    spikeAt.set(index, 45 + rand() * 35);
  }

  const roughStart = Math.floor(count * 0.32);
  const roughEnd = Math.floor(count * 0.45);

  const frames: FrameSample[] = new Array(count);
  let timeMs = 0;
  for (let i = 0; i < count; i++) {
    let frameTimeMs = baseMs + (rand() - 0.5) * 1.2;
    if (i >= roughStart && i < roughEnd) frameTimeMs += 1.5 + rand() * 2;
    const spikeMs = spikeAt.get(i);
    if (spikeMs !== undefined) frameTimeMs = spikeMs;

    frames[i] = {
      timeMs,
      frameTimeMs,
      generated: i % 5 < SYNTHETIC_GENERATED_FRACTION * 5,
      gpuLoadPct: 92 + rand() * 7,
      gpuClockMhz: 2550 + rand() * 120,
      gpuPowerW: 200 + rand() * 40,
      vramUsedMb: 9000 + (2400 * i) / count + rand() * 60,
      cpuLoadPct: 35 + rand() * 12,
      cpuBusyMs: 4.5 + rand() * 1.2,
      gpuBusyMs: frameTimeMs * (0.9 + rand() * 0.06),
    };
    timeMs += frameTimeMs;
  }

  // Every spike must clear the stutter rule even for a worst-case median.
  const worstMedian = baseMs + 0.6 + 3.5;
  for (const spikeMs of spikeAt.values()) {
    if (spikeMs <= STUTTER.medianMultiplier * worstMedian || spikeMs <= STUTTER.minFrameTimeMs) {
      throw new RangeError("synthetic spike does not satisfy the STUTTER rule");
    }
  }

  return frames;
}

/**
 * Run metadata to pair with `makeSyntheticFrames()` output — DLSS 3 enabled and
 * RAM running below its rated speed, so the frame-gen badge/tile and the
 * hardware-panel warn row both light up. Compose the summary via
 * `computeRunSummary(frames)` and spread it in.
 */
export const syntheticRunBase: Omit<Run, "summary"> = {
  id: "run_synthetic_0001",
  game: "Cyberpunk 2077",
  captureSource: "capframex",
  visibility: RUN_VISIBILITY.public,
  status: RUN_STATUS.validated,
  hardware: {
    gpu: "NVIDIA GeForce RTX 4070",
    cpu: "AMD Ryzen 7 7800X3D",
    gpuVendor: "nvidia",
    ramGb: 32,
    ramSpeedMtps: 4800,
    ramRatedSpeedMtps: 6000,
    os: "Windows 11",
    gpuDriver: "566.14",
    resolution: "2560x1440",
  },
  generatedFrameTech: "dlss3",
  diagnostics: [],
  schemaVersion: CURRENT_SCHEMA_VERSION,
  parserVersion: "capframex@1.0.0",
  createdAt: "2026-06-01T12:00:00.000Z",
  framesObjectKey: `runs/run_synthetic_0001/${"b".repeat(32)}.parquet`,
  signatureValid: true,
};
