/**
 * Sample runs — realistic + malformed (IMPLEMENTATION_PLAN §2.4).
 *
 * These feed parser, UI, and statistics tests downstream. The valid fixtures are
 * schema-clean; the `tampered` one is schema-valid but physically inconsistent
 * (so Phase 7's recompute/physics checks have something to catch); the `malformed`
 * group is deliberately schema-invalid for reject tests.
 */

import { RUN_VISIBILITY, RUN_STATUS } from "./visibility";
import { CURRENT_SCHEMA_VERSION, INGEST_LIMITS } from "./constants";
import type { CreateRunRequest } from "./schemas";
import type { FrameSample, Run, RunSummary } from "./types";

const PARSER_VERSION = "capframex@1.0.0";

/** A clean ~120 FPS frame stream with full secondary sensors. */
export const validFrames: FrameSample[] = Array.from({ length: 16 }, (_, i) => ({
  timeMs: i * 8.3,
  frameTimeMs: 8.3 + (i % 4 === 0 ? 0.4 : 0),
  generated: false,
  gpuLoadPct: 97,
  gpuClockMhz: 2610,
  gpuPowerW: 220,
  vramUsedMb: 9200,
  cpuLoadPct: 41,
  cpuBusyMs: 5.1,
  gpuBusyMs: 7.9,
}));

/** Same capture, but from a source/vendor that omits secondary sensors (§7.3). */
export const missingSensorFrames: FrameSample[] = validFrames.map((f) => ({
  timeMs: f.timeMs,
  frameTimeMs: f.frameTimeMs,
}));

export const validSummary: RunSummary = {
  avgFps: 119.8,
  onePercentLowFps: 96.2,
  pointOnePercentLowFps: 78.4,
  frameTimeP50Ms: 8.3,
  frameTimeP95Ms: 10.1,
  frameTimeP99Ms: 12.7,
  stutterCount: 3,
  generatedFramePct: 0,
  pointOnePercentLowConfidence: "high",
  sampleCount: 7200,
  durationSeconds: 60,
};

const baseHardware = {
  gpu: "NVIDIA GeForce RTX 4070",
  cpu: "AMD Ryzen 7 7800X3D",
  gpuVendor: "nvidia",
  ramGb: 32,
  ramSpeedMtps: 6000,
  ramRatedSpeedMtps: 6000,
  os: "Windows 11",
  gpuDriver: "566.36",
  resolution: "2560x1440",
} as const;

/** A complete, valid run (validated + public so it is aggregate-eligible). */
export const validRun: Run = {
  id: "run_valid_0001",
  game: "Cyberpunk 2077",
  captureSource: "capframex",
  visibility: RUN_VISIBILITY.public,
  status: RUN_STATUS.validated,
  hardware: { ...baseHardware },
  summary: validSummary,
  generatedFrameTech: "none",
  schemaVersion: CURRENT_SCHEMA_VERSION,
  parserVersion: PARSER_VERSION,
  createdAt: "2026-06-01T12:00:00.000Z",
  framesObjectKey: "runs/run_valid_0001.parquet",
  signatureValid: true,
};

/** A well-formed create request — the happy-path ingest payload. */
export const validCreateRunRequest: CreateRunRequest = {
  game: "Cyberpunk 2077",
  captureSource: "capframex",
  visibility: RUN_VISIBILITY.unlisted,
  hardware: { ...baseHardware },
  summary: validSummary,
  generatedFrameTech: "none",
  parquetByteLength: 2_400_000,
  schemaVersion: CURRENT_SCHEMA_VERSION,
  parserVersion: PARSER_VERSION,
};

/**
 * Locale-variant payload: untrimmed game title with diacritics, and a defaulted
 * visibility/generatedFrameTech/schemaVersion (omitted so the schema fills them).
 * Used to prove normalization (trim) and defaulting are idempotent.
 */
export const localeVariantRawCreateRequest = {
  game: "  Pokémon — Légendes  ",
  captureSource: "capframex",
  hardware: { ...baseHardware },
  summary: validSummary,
  parquetByteLength: 2_400_000,
  parserVersion: PARSER_VERSION,
};

/**
 * Schema-VALID but internally inconsistent: the reported avg FPS (240) is
 * impossible given the ~8.3 ms frame times, and GPU load is implausibly low for
 * that FPS. The §11.5 recompute / §18 physics checks must flag this.
 */
export const tamperedCreateRequest: CreateRunRequest = {
  ...validCreateRunRequest,
  summary: {
    ...validSummary,
    avgFps: 240,
    onePercentLowFps: 239,
    pointOnePercentLowFps: 238,
  },
  hardware: { ...baseHardware },
};

/** Deliberately schema-INVALID payloads, keyed by what's wrong (reject tests). */
export const malformedCreateRequests: Record<string, unknown> = {
  emptyGame: { ...validCreateRunRequest, game: "   " },
  missingGpu: {
    ...validCreateRunRequest,
    hardware: { ...baseHardware, gpu: "" },
  },
  negativeFrameTime: { timeMs: 0, frameTimeMs: -1 },
  generatedPctOutOfRange: {
    ...validCreateRunRequest,
    summary: { ...validSummary, generatedFramePct: 2 },
  },
  zeroSampleCount: {
    ...validCreateRunRequest,
    summary: { ...validSummary, sampleCount: 0 },
  },
  zeroDuration: {
    ...validCreateRunRequest,
    summary: { ...validSummary, durationSeconds: 0 },
  },
  badCaptureSource: { ...validCreateRunRequest, captureSource: "fraps" },
  fractionalStutterCount: {
    ...validCreateRunRequest,
    summary: { ...validSummary, stutterCount: 1.5 },
  },
  // §11.10 upload-limit rejects: caught BEFORE a presigned URL is issued.
  oversizedParquet: {
    ...validCreateRunRequest,
    parquetByteLength: INGEST_LIMITS.maxParquetBytes + 1,
  },
  zeroParquetByteLength: { ...validCreateRunRequest, parquetByteLength: 0 },
  tooManyFrames: {
    ...validCreateRunRequest,
    summary: { ...validSummary, sampleCount: INGEST_LIMITS.maxFramesPerRun + 1 },
  },
  tooFewFrames: {
    ...validCreateRunRequest,
    summary: { ...validSummary, sampleCount: INGEST_LIMITS.minFramesPerRun - 1 },
  },
};

export const fixtures = {
  validFrames,
  missingSensorFrames,
  validSummary,
  validRun,
  validCreateRunRequest,
  localeVariantRawCreateRequest,
  tamperedCreateRequest,
  malformedCreateRequests,
} as const;
