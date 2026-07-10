import { describe, expect, it } from "vitest";
import {
  createRunRequestSchema,
  finalizeRunRequestSchema,
  runResponseSchema,
  runSummarySchema,
  hardwareSnapshotSchema,
  frameSampleSchema,
  type CreateRunRequest,
} from "./schemas";
import {
  fixtures,
  validCreateRunRequest,
  localeVariantRawCreateRequest,
  malformedCreateRequests,
} from "./fixtures";
import { RUN_VISIBILITY } from "./visibility";
import { CURRENT_SCHEMA_VERSION } from "./constants";
import type { FrameSample, HardwareSnapshot, RunSummary } from "./types";

describe("schema accept/reject (§3.1)", () => {
  it("accepts a well-formed create request", () => {
    expect(createRunRequestSchema.safeParse(validCreateRunRequest).success).toBe(true);
  });

  it("accepts the valid run response and summary fixtures", () => {
    expect(runSummarySchema.safeParse(fixtures.validSummary).success).toBe(true);
    expect(hardwareSnapshotSchema.safeParse(fixtures.validRun.hardware).success).toBe(true);
  });

  it("accepts a sensor-complete and a sensor-sparse frame", () => {
    expect(frameSampleSchema.safeParse(fixtures.validFrames[0]).success).toBe(true);
    expect(frameSampleSchema.safeParse(fixtures.missingSensorFrames[0]).success).toBe(true);
  });

  it("accepts busy-time bottleneck fields and rejects negative ones (§7 spike)", () => {
    const frame = { timeMs: 0, frameTimeMs: 8.3, cpuBusyMs: 5.1, gpuBusyMs: 7.9 };
    expect(frameSampleSchema.safeParse(frame).success).toBe(true);
    expect(frameSampleSchema.safeParse({ ...frame, cpuBusyMs: -1 }).success).toBe(false);
    expect(frameSampleSchema.safeParse({ ...frame, gpuBusyMs: -1 }).success).toBe(false);
  });

  it("rejects every malformed payload", () => {
    for (const [name, payload] of Object.entries(malformedCreateRequests)) {
      const result =
        name === "negativeFrameTime"
          ? frameSampleSchema.safeParse(payload)
          : createRunRequestSchema.safeParse(payload);
      expect(result.success, `expected ${name} to be rejected`).toBe(false);
    }
  });

  it("accepts the tampered request at the schema layer (it is schema-valid by design)", () => {
    // Tampering is caught by the server recompute/physics checks (Phase 7),
    // not by static validation — the schema must not reject it.
    expect(createRunRequestSchema.safeParse(fixtures.tamperedCreateRequest).success).toBe(true);
  });
});

describe("normalization & defaulting idempotence (§3.3)", () => {
  it("trims the game title and fills defaults", () => {
    const parsed = createRunRequestSchema.parse(localeVariantRawCreateRequest);
    expect(parsed.game).toBe("Pokémon — Légendes");
    expect(parsed.visibility).toBe(RUN_VISIBILITY.unlisted);
    expect(parsed.generatedFrameTech).toBe("none");
    expect(parsed.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
  });

  it("is idempotent: parse(parse(x)) deep-equals parse(x)", () => {
    const once = createRunRequestSchema.parse(localeVariantRawCreateRequest);
    const twice = createRunRequestSchema.parse(once);
    expect(twice).toEqual(once);
  });
});

describe("DTO round-trip stability (§3.2)", () => {
  it("survives parse → serialize → parse unchanged", () => {
    const parsed = createRunRequestSchema.parse(validCreateRunRequest);
    const roundTripped = createRunRequestSchema.parse(JSON.parse(JSON.stringify(parsed)));
    expect(roundTripped).toEqual(parsed);
  });

  it("round-trips the finalize and run-response DTOs", () => {
    const finalize = finalizeRunRequestSchema.parse({
      uploadObjectKey: "staging/runs/run_valid_0001.parquet",
      visibility: RUN_VISIBILITY.public,
      managementTokenHash: "a".repeat(64),
    });
    // `signatureValid` is server-derived and not part of the inbound finalize DTO;
    // its round-trip is covered by the run-response assertion below.
    expect(finalizeRunRequestSchema.parse(JSON.parse(JSON.stringify(finalize)))).toEqual(finalize);

    const run = runResponseSchema.parse(fixtures.validRun);
    expect(runResponseSchema.parse(JSON.parse(JSON.stringify(run)))).toEqual(run);
  });

  it("requires a management token hash for pre-auth finalize", () => {
    expect(
      finalizeRunRequestSchema.safeParse({
        uploadObjectKey: "staging/runs/run_valid_0001.parquet",
        visibility: RUN_VISIBILITY.unlisted,
      }).success,
    ).toBe(false);
  });

  it("rejects owner-only private visibility on the pre-auth ingest DTOs", () => {
    expect(
      createRunRequestSchema.safeParse({
        ...validCreateRunRequest,
        visibility: RUN_VISIBILITY.private,
      }).success,
    ).toBe(false);
    expect(
      finalizeRunRequestSchema.safeParse({
        uploadObjectKey: "staging/runs/run_valid_0001.parquet",
        visibility: RUN_VISIBILITY.private,
        managementTokenHash: "a".repeat(64),
      }).success,
    ).toBe(false);
  });

  it("round-trips a generated spread of summaries (property-style)", () => {
    // Lightweight generative property check without pulling in a PBT dependency:
    // a deterministic LCG drives the inputs, so failures reproduce exactly.
    let seed = 0x9e3779b1;
    const rand = () => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed / 0xffffffff;
    };
    for (let i = 0; i < 200; i++) {
      const summary: RunSummary = {
        avgFps: 0.001 + rand() * 480,
        onePercentLowFps: 0.001 + rand() * 480,
        pointOnePercentLowFps: 0.001 + rand() * 480,
        frameTimeP50Ms: 0.001 + rand() * 50,
        frameTimeP95Ms: 0.001 + rand() * 50,
        frameTimeP99Ms: 0.001 + rand() * 50,
        stutterCount: Math.floor(rand() * 200),
        generatedFramePct: rand(),
        pointOnePercentLowConfidence: (["high", "medium", "low"] as const)[
          Math.floor(rand() * 3)
        ]!,
        sampleCount: 1 + Math.floor(rand() * 50000),
        durationSeconds: 0.001 + rand() * 600,
      };
      const parsed = runSummarySchema.parse(summary);
      const again = runSummarySchema.parse(JSON.parse(JSON.stringify(parsed)));
      expect(again).toEqual(parsed);
    }
  });
});

describe("schema/type drift guards (compile-time)", () => {
  // These bodies never need to run to do their job: tsc --noEmit type-checks
  // the file, so any divergence between a domain type and its DTO schema is a
  // build error. The runtime assertions just keep the test non-empty.
  it("RunSummary <-> runSummarySchema stay mutually assignable", () => {
    const fromSchema = runSummarySchema.parse(fixtures.validSummary);
    const asDomain: RunSummary = fromSchema;
    const backToSchema: import("./schemas").RunSummaryResponse = asDomain;
    expect(backToSchema).toEqual(fromSchema);
  });

  it("HardwareSnapshot and FrameSample stay in sync with their schemas", () => {
    const hw: HardwareSnapshot = hardwareSnapshotSchema.parse(fixtures.validRun.hardware);
    const hwBack: import("./schemas").CreateRunRequest["hardware"] = hw;
    const frame: FrameSample = frameSampleSchema.parse(fixtures.validFrames[0]);
    expect(hwBack).toEqual(hw);
    expect(frame.frameTimeMs).toBeGreaterThan(0);
  });

  it("CreateRunRequest infers to the exported type", () => {
    const req: CreateRunRequest = createRunRequestSchema.parse(validCreateRunRequest);
    expect(req.parserVersion).toBeTruthy();
  });
});
