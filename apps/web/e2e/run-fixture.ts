/**
 * The deterministic run the e2e suite renders (§13 Verify): synthetic frames
 * from the shared seeded generator, summary computed by the SAME canonical
 * math the product uses, parquet bytes built by the same writer the upload
 * path uses. The run row is seeded into the e2e Postgres (global-setup) for
 * SSR; the frames flow is mocked in the browser (frames-URL JSON + parquet
 * body), so no R2 is involved.
 */

import { computeRunSummary, framesToColumns, runDiagnostics } from "@heimdall/parsers";
import { makeSyntheticFrames, syntheticRunBase } from "@heimdall/shared";
import type { Diagnostic, Run } from "@heimdall/shared";
import { buildFramesParquet } from "../src/lib/upload/build-parquet";

export const E2E_RUN_ID = "run_e2e_fixture1";
export const E2E_VRAM_RUN_ID = "run_e2e_vram_fixture";
export const E2E_BENCHMARK_SET_RUN_ID = "run_e2e_benchmark_set";
export const E2E_BENCHMARK_SET_ID = "d2f822bc-b02d-4b90-8f45-997d7c3d66c9";
export const E2E_BENCHMARK_SET_SECRET = "a".repeat(43);

export const e2eFrames = makeSyntheticFrames({ seed: 7, count: 7200 });

const e2eSummary = computeRunSummary(e2eFrames);

/**
 * REAL rules-engine output for the fixture — not hand-authored rows. The
 * fixture hardware runs RAM below rated (4800 vs 6000) and an outdated driver
 * (566.14 vs the curated 566.36 for this title and latest-known 610.74), so the
 * engine emits the RAM, game-ready, and currency findings. global-setup persists
 * these so the /runs/[id] page server-renders them exactly as production would.
 */
export const e2eDiagnostics: Omit<Diagnostic, "id">[] = runDiagnostics({
  summary: e2eSummary,
  hardware: syntheticRunBase.hardware,
  source: syntheticRunBase.captureSource,
  vendor: syntheticRunBase.hardware.gpuVendor ?? "unknown",
  game: { requiredDriver: "566.36" },
  driverPlatform: { vendor: "nvidia", os: "windows", component: "gpu" },
  driverCatalog: {
    vendor: "nvidia",
    os: "windows",
    component: "gpu",
    latestVersion: "610.74",
  },
  frames: framesToColumns(e2eFrames),
});

export const e2eFixtureRun: Run = {
  ...syntheticRunBase,
  id: E2E_RUN_ID,
  summary: e2eSummary,
  diagnostics: e2eDiagnostics.map((finding, index) => ({ id: `diag_e2e_${index}`, ...finding })),
  framesObjectKey: `runs/${E2E_RUN_ID}/${"c".repeat(32)}.parquet`,
};

/** Public repeatable passes for the run-page variance card (§16c.2). */
export const e2eBenchmarkSetFixtureRun: Run = {
  ...e2eFixtureRun,
  id: E2E_BENCHMARK_SET_RUN_ID,
  benchmarkSetId: E2E_BENCHMARK_SET_ID,
  methodologyManifest: {
    version: 1,
    sceneType: "benchmark-scene",
    scene: "Dogtown route",
    settingsPreset: "Ultra",
    graphicsApi: "dx12",
    resolution: e2eFixtureRun.hardware.resolution,
    upscaler: "none",
    rayTracing: "off",
    frameGeneration: e2eFixtureRun.generatedFrameTech,
    framePacing: { vsync: false, vrr: false },
  },
  framesObjectKey: `runs/${E2E_BENCHMARK_SET_RUN_ID}/${"b".repeat(32)}.parquet`,
};

export const e2eBenchmarkSetPeerRuns: Run[] = [
  {
    ...e2eBenchmarkSetFixtureRun,
    id: "run_e2e_benchmark_set_peer_1",
    summary: { ...e2eSummary, avgFps: e2eSummary.avgFps + 0.5 },
    framesObjectKey: `runs/run_e2e_benchmark_set_peer_1/${"d".repeat(32)}.parquet`,
  },
  {
    ...e2eBenchmarkSetFixtureRun,
    id: "run_e2e_benchmark_set_peer_2",
    summary: { ...e2eSummary, avgFps: e2eSummary.avgFps - 0.5 },
    framesObjectKey: `runs/run_e2e_benchmark_set_peer_2/${"e".repeat(32)}.parquet`,
  },
  {
    ...e2eBenchmarkSetFixtureRun,
    id: "run_e2e_benchmark_set_warmup",
    summary: { ...e2eSummary, avgFps: e2eSummary.avgFps + 50 },
    isWarmup: true,
    framesObjectKey: `runs/run_e2e_benchmark_set_warmup/${"f".repeat(32)}.parquet`,
  },
];

// Keep the ordinary fixture clean of VRAM findings so its visual baseline stays
// focused on the Phase 5 run page. This second fixture turns only the known
// synthetic stutters into saturated-VRAM frames, exercising §15.1 end to end.
export const e2eVramFrames = e2eFrames.map((frame) =>
  frame.frameTimeMs > 40 ? { ...frame, vramUsedMb: 12_000 } : frame,
);
const e2eVramHardware = {
  ...syntheticRunBase.hardware,
  gpuVramTotalMb: 12_288,
  ramSpeedMtps: 6000,
  ramRatedSpeedMtps: 6000,
  gpuDriver: "570.00",
};
const e2eVramSummary = computeRunSummary(e2eVramFrames);

export const e2eVramDiagnostics: Omit<Diagnostic, "id">[] = runDiagnostics({
  summary: e2eVramSummary,
  hardware: e2eVramHardware,
  source: syntheticRunBase.captureSource,
  vendor: e2eVramHardware.gpuVendor ?? "unknown",
  frames: framesToColumns(e2eVramFrames),
});

export const e2eVramFixtureRun: Run = {
  ...syntheticRunBase,
  id: E2E_VRAM_RUN_ID,
  hardware: e2eVramHardware,
  summary: e2eVramSummary,
  diagnostics: e2eVramDiagnostics.map((finding, index) => ({ id: `diag_vram_${index}`, ...finding })),
  framesObjectKey: `runs/${E2E_VRAM_RUN_ID}/${"v".repeat(32)}.parquet`,
};

let defaultParquetBytes: Promise<Buffer> | undefined;
let vramParquetBytes: Promise<Buffer> | undefined;

/** Cache immutable fixture bytes; each mocked browser route can safely reuse them. */
export function e2eParquetBytes(frames = e2eFrames): Promise<Buffer> {
  if (frames === e2eFrames) {
    defaultParquetBytes ??= buildFramesParquet(e2eFrames).then((bytes) => Buffer.from(bytes));
    return defaultParquetBytes;
  }
  if (frames === e2eVramFrames) {
    vramParquetBytes ??= buildFramesParquet(e2eVramFrames).then((bytes) => Buffer.from(bytes));
    return vramParquetBytes;
  }
  return buildFramesParquet(frames).then((bytes) => Buffer.from(bytes));
}
