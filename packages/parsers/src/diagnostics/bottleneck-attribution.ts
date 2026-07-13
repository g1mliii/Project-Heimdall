/**
 * Confidence-graded bottleneck attribution (§16b). Unlike the utilization-based
 * `cpu-bottleneck` fallback (which infers from CPU/GPU *load* percentages), these
 * rules read VERIFIED per-frame execution times — PresentMon v2 `CPUBusy`/
 * `GPUBusy` and CapFrameX `MsGPUActive` — and phrase every finding as a
 * *likelihood*, never a certainty. Four mutually-exclusive rules share one
 * analysis pass and each fires only in its own regime:
 *
 * - `likely-cpu-bound` — CPU busy is the critical path on the dominant share;
 * - `likely-gpu-bound` — GPU busy dominates;
 * - `frame-capped-or-display-limited` — frame time tracks a stable cadence above
 *   both busy times (a limiter/VSync/VRR ceiling, not a hardware bottleneck);
 * - `telemetry-insufficient` — busy telemetry exists but is too sparse to
 *   attribute (fires ONLY when the columns are present, so a run without them
 *   yields no new finding — the Phase 6 regression invariant).
 *
 * GPU-execution timing is HAGS-affected, so it is used here only as a likelihood
 * signal and is NEVER promoted to a hard integrity flag.
 */

import { DIAGNOSTICS, type ConfidenceLevel, type DiagnosticEvidence } from "@heimdall/shared";
import type { DiagnosticRule, DiagnosticRuleContext, RuleVerdict } from "./types";
import { commonCapFpsForFrameTime } from "./frame-cap";

const RULE_VERSION = "1.0.0";
const BUSY_SENSORS = ["cpuBusyMs", "gpuBusyMs"] as const;

type Regime = "cpu" | "gpu" | "capped" | "insufficient" | "inconclusive";

export interface BottleneckAnalysis {
  regime: Regime;
  confidence: ConfidenceLevel;
  evidence: DiagnosticEvidence;
  /** Dominant regime's coverage-adjusted share, for the copy. */
  dominantPct: number;
  coveragePct: number;
}

/**
 * `runDiagnostics` shares one context among all rules. A WeakMap keeps the
 * O(frameCount) attribution scan scoped to that invocation without retaining
 * captures after the engine returns.
 */
const analysisByContext = new WeakMap<DiagnosticRuleContext, BottleneckAnalysis>();

function hasFrameAlignedBusyTelemetry(ctx: DiagnosticRuleContext): boolean {
  const sensors = ctx.input.capabilityManifest?.sensors;
  return Boolean(
    sensors?.cpuBusyMs.present &&
      sensors.cpuBusyMs.frameAligned &&
      sensors.gpuBusyMs.present &&
      sensors.gpuBusyMs.frameAligned,
  );
}

function gradeConfidence(coverage: number): ConfidenceLevel {
  if (coverage >= DIAGNOSTICS.bottleneckHighConfidenceCoverage) return "high";
  if (coverage >= DIAGNOSTICS.bottleneckMediumConfidenceCoverage) return "medium";
  return "low";
}

/**
 * Classify every frame that carries BOTH busy times, then pick the dominant
 * regime. Total function: returns `insufficient` when the paired coverage is too
 * thin to attribute, `inconclusive` when covered but no regime is dominant.
 */
export function analyzeBottleneck(ctx: DiagnosticRuleContext): BottleneckAnalysis {
  const cached = analysisByContext.get(ctx);
  if (cached) return cached;

  const { input, frameCount } = ctx;
  // A busy-time column alone is not enough evidence to correlate it with a
  // frame. This preserves the Phase 6 behavior when no capability manifest was
  // supplied and makes a real matrix's non-aligned evidence effective.
  if (!hasFrameAlignedBusyTelemetry(ctx)) {
    const result: BottleneckAnalysis = {
      regime: "inconclusive",
      confidence: "low",
      evidence: {},
      dominantPct: 0,
      coveragePct: 0,
    };
    analysisByContext.set(ctx, result);
    return result;
  }

  const cpu = input.frames.cpuBusyMs;
  const gpu = input.frames.gpuBusyMs;
  const frameTimes = input.frames.frameTimeMs;

  let considered = 0;
  let cpuBound = 0;
  let gpuBound = 0;
  let capped = 0;
  const margin = DIAGNOSTICS.bottleneckDominanceMargin;

  if (cpu && gpu) {
    for (let i = 0; i < frameCount; i++) {
      const cpuBusy = cpu[i];
      const gpuBusy = gpu[i];
      const frameTimeMs = frameTimes[i];
      if (
        cpuBusy === undefined ||
        gpuBusy === undefined ||
        frameTimeMs === undefined ||
        !Number.isFinite(cpuBusy) ||
        !Number.isFinite(gpuBusy) ||
        !Number.isFinite(frameTimeMs)
      ) {
        continue;
      }
      considered++;
      const critical = Math.max(cpuBusy, gpuBusy);
      const overCritical = frameTimeMs >= critical * (1 + DIAGNOSTICS.bottleneckCapMarginFraction);
      if (overCritical && commonCapFpsForFrameTime(frameTimeMs) !== undefined) {
        capped++;
      } else if (cpuBusy > gpuBusy * (1 + margin)) {
        cpuBound++;
      } else if (gpuBusy > cpuBusy * (1 + margin)) {
        gpuBound++;
      }
    }
  }

  const coverage = frameCount > 0 ? considered / frameCount : 0;
  const baseEvidence: DiagnosticEvidence = {
    coverageFraction: coverage,
    sensors: [...BUSY_SENSORS],
    metrics: {
      pairedSamples: considered,
      cpuBoundFraction: considered > 0 ? cpuBound / considered : 0,
      gpuBoundFraction: considered > 0 ? gpuBound / considered : 0,
      cappedFraction: considered > 0 ? capped / considered : 0,
    },
    ...(input.capabilityManifest?.caveats.length
      ? { caveats: input.capabilityManifest.caveats }
      : {}),
  };

  if (
    considered < DIAGNOSTICS.bottleneckMinPairedSamples ||
    coverage < DIAGNOSTICS.bottleneckMinCoverageFraction
  ) {
    const result: BottleneckAnalysis = {
      regime: "insufficient",
      confidence: "low",
      evidence: baseEvidence,
      dominantPct: 0,
      coveragePct: Math.round(coverage * 100),
    };
    analysisByContext.set(ctx, result);
    return result;
  }

  const fractions: Array<[Exclude<Regime, "insufficient" | "inconclusive">, number]> = [
    ["capped", capped / considered],
    ["cpu", cpuBound / considered],
    ["gpu", gpuBound / considered],
  ];
  fractions.sort((a, b) => b[1] - a[1]);
  const [regime, fraction] = fractions[0]!;
  const dominant = fraction >= DIAGNOSTICS.bottleneckDominantFraction;

  const result: BottleneckAnalysis = {
    regime: dominant ? regime : "inconclusive",
    confidence: gradeConfidence(coverage),
    evidence: baseEvidence,
    dominantPct: Math.round(fraction * 100),
    coveragePct: Math.round(coverage * 100),
  };
  analysisByContext.set(ctx, result);
  return result;
}

/** Build a rule that fires only when the shared analysis lands in its regime. */
function attributionRule(
  code: string,
  regime: Regime,
  build: (analysis: BottleneckAnalysis) => Pick<RuleVerdict, "severity" | "title" | "detail">,
): DiagnosticRule {
  return {
    code,
    version: RULE_VERSION,
    requiredSensors: [...BUSY_SENSORS],
    evaluate(ctx) {
      const analysis = analyzeBottleneck(ctx);
      if (analysis.regime !== regime) return null;
      return {
        ...build(analysis),
        confidence: analysis.confidence,
        evidence: analysis.evidence,
      };
    },
  };
}

export const likelyCpuBoundRule = attributionRule("likely-cpu-bound", "cpu", (a) => ({
  severity: "info",
  title: "Likely CPU-bound",
  detail:
    `On ${a.dominantPct}% of frames (over ${a.coveragePct}% paired-telemetry coverage) the CPU's ` +
    `per-frame work outran the GPU's, so the CPU is the likely limiter. A faster CPU — or raising ` +
    `resolution/graphics settings to shift work back to the GPU — would probably raise your frame rate.`,
}));

export const likelyGpuBoundRule = attributionRule("likely-gpu-bound", "gpu", (a) => ({
  severity: "info",
  title: "Likely GPU-bound",
  detail:
    `On ${a.dominantPct}% of frames (over ${a.coveragePct}% paired-telemetry coverage) the GPU's ` +
    `per-frame work outran the CPU's, so the GPU is the likely limiter. Lowering graphics settings or ` +
    `resolution — or a faster GPU — would probably raise your frame rate.`,
}));

export const frameCappedOrDisplayLimitedRule = attributionRule(
  "frame-capped-or-display-limited",
  "capped",
  (a) => ({
    severity: "info",
    title: "Likely frame-capped or display-limited",
    detail:
      `On ${a.dominantPct}% of frames the frame time held a steady cadence above both the CPU and GPU ` +
      `work times — a frame-rate limiter, VSync, or a VRR/refresh ceiling is the likely cause rather ` +
      `than a hardware bottleneck. Raise or remove the cap to see whether the hardware has headroom.`,
  }),
);

export const telemetryInsufficientRule = attributionRule(
  "telemetry-insufficient",
  "insufficient",
  (a) => ({
    severity: "info",
    title: "Not enough telemetry to attribute a bottleneck",
    detail:
      `This capture carries CPU/GPU busy-time telemetry, but only ${a.coveragePct}% of frames have both ` +
      `— too sparse to say confidently whether the CPU, GPU, or a frame cap is limiting performance. ` +
      `A capture with denser busy-time telemetry would let Heimdall attribute the bottleneck.`,
  }),
);
