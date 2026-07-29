/**
 * Client upload engine coverage (§11.1–§11.4; plan item 12.1 client side).
 * Pure Node — no DB, no network: the transport is injected, and the PUT bytes
 * are decoded with the SAME hyparquet reader the verification worker uses, so
 * the client→server recompute round trip is proven end to end here.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { parquetReadObjects } from "hyparquet";
import { computeRunSummary } from "@heimdall/parsers";
import {
  createRunRequestSchema,
  finalizeRunRequestSchema,
  hashManagementToken,
  INGEST_LIMITS,
  rowsToFrameSamples,
} from "@heimdall/shared";
import {
  uploadCapture,
  uploadCaptureBytes,
  type UploadFailure,
  type UploadProgress,
  type UploadTransport,
} from "./upload-run";

const FIXTURES = path.resolve(
  import.meta.dirname,
  "../../parsers/fixtures",
);
const BENCHMARK_SET_ID = "57ba4bd4-8b3e-4a2b-a0d0-92fb48367d5d";
const BENCHMARK_SET_SECRET = "a".repeat(43);

function fixtureFile(relative: string): File {
  const bytes = readFileSync(path.join(FIXTURES, relative));
  return new File([new Uint8Array(bytes)], path.basename(relative));
}

function generatedPresentMonFile(): File {
  const lines = [
    "Application,ProcessID,SwapChainAddress,FrameType,CPUStartTime,FrameTime",
  ];
  for (let i = 0; i < 10; i += 1) {
    lines.push(
      `game.exe,1234,0xAAAA,${i % 2 === 0 ? "Application" : "AMD AFMF"},${3500 + i * 10},10`,
    );
  }
  return new File([lines.join("\n")], "presentmon-generated.csv");
}

function vsyncPresentMonFile(): File {
  const [header, ...rows] = readFileSync(path.join(FIXTURES, "presentmon/v2-basic.csv"), "utf8")
    .trim()
    .split("\n");
  const columns = header!.split(",");
  const syncInterval = columns.indexOf("SyncInterval");
  const allowsTearing = columns.indexOf("AllowsTearing");
  if (syncInterval < 0 || allowsTearing < 0) throw new Error("v2 fixture is missing PresentMon sync columns");

  const vsyncRows = rows.map((row) => {
    const values = row.split(",");
    values[syncInterval] = "1";
    values[allowsTearing] = "0";
    return values.join(",");
  });
  return new File([[header, ...vsyncRows].join("\n")], "presentmon-vsync.csv");
}

interface TransportLog {
  createBody?: unknown;
  finalizeBody?: unknown;
  finalizeUrl?: string;
  putUrl?: string;
  putBytes?: Uint8Array;
  putContentType?: string;
}

function mockTransport(
  log: TransportLog,
  overrides: { createStatus?: number; finalizeStatus?: number; finalizeError?: Error } = {},
): UploadTransport {
  return {
    fetch: vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      if (url === "/api/runs") {
        log.createBody = body;
        if (overrides.createStatus) {
          return Response.json(
            { error: { code: "rate-limited", message: "slow down" } },
            { status: overrides.createStatus },
          );
        }
        return Response.json(
          {
            id: "run_test01",
            uploadUrl: "https://r2.example.test/put",
            uploadObjectKey: "staging/runs/run_test01.parquet",
          },
          { status: 201 },
        );
      }
      log.finalizeUrl = url;
      log.finalizeBody = body;
      if (overrides.finalizeError) {
        throw overrides.finalizeError;
      }
      if (overrides.finalizeStatus) {
        return Response.json(
          {
            error:
              overrides.finalizeStatus >= 500
                ? { code: "internal", message: "try again later" }
                : { code: "object-missing", message: "upload first" },
          },
          { status: overrides.finalizeStatus },
        );
      }
      return Response.json({ id: "run_test01", status: "pending" });
    }) as unknown as typeof fetch,
    putWithProgress: vi.fn(async (url, bytes, contentType, onProgress) => {
      log.putUrl = url;
      log.putBytes = bytes;
      log.putContentType = contentType;
      onProgress(bytes.byteLength);
    }),
  };
}

async function expectFinalizeRecovery(failure: UploadFailure, log: TransportLog) {
  expect(failure.recovery?.runId).toBe("run_test01");
  if (!failure.recovery) {
    throw new Error("expected an ambiguous finalize recovery token");
  }
  expect(await hashManagementToken(failure.recovery.managementToken)).toBe(
    finalizeRunRequestSchema.parse(log.finalizeBody).managementTokenHash,
  );
}

describe("uploadCapture engine", () => {
  it("parses locally, uploads direct to R2, finalizes with a hashed token (§11.1–11.4)", async () => {
    const log: TransportLog = {};
    const stages: UploadProgress["stage"][] = [];
    const result = await uploadCapture(fixtureFile("capframex/csv/nvidia-full-sensors.csv"), {
      game: " Cyberpunk 2077 ",
      visibility: "unlisted",
      transport: mockTransport(log),
      onProgress: (p) => stages.push(p.stage),
    });

    expect(result.ok, JSON.stringify(result)).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.runId).toBe("run_test01");
    expect(result.captureSource).toBe("capframex");
    expect(stages).toEqual([
      "parsing",
      "building-parquet",
      "creating",
      "uploading",
      "uploading",
      "finalizing",
      "done",
    ]);

    // The create payload is schema-valid and binds the exact parquet size.
    const createBody = createRunRequestSchema.parse(log.createBody);
    expect(createBody.game).toBe("Cyberpunk 2077");
    expect(createBody.parquetByteLength).toBe(log.putBytes!.byteLength);
    expect(createBody.summary).toEqual(result.summary);
    expect(createBody.capabilityManifest?.sensors.gpuLoadPct).toEqual({
      present: true,
      frameAligned: true,
    });

    // Raw file never transits the API: the PUT carries Parquet, not CSV.
    expect(log.putUrl).toBe("https://r2.example.test/put");
    expect(log.putContentType).toBe("application/vnd.apache.parquet");
    expect(log.putBytes!.byteLength).toBeGreaterThan(0);
    expect(new TextDecoder().decode(log.putBytes!.slice(0, 4))).toBe("PAR1");

    // Finalize carries the run's staging key + the HASH of the shown-once token.
    const finalizeBody = finalizeRunRequestSchema.parse(log.finalizeBody);
    expect(log.finalizeUrl).toBe("/api/runs/run_test01/finalize");
    expect(finalizeBody.uploadObjectKey).toBe("staging/runs/run_test01.parquet");
    expect(finalizeBody.managementTokenHash).toBe(
      await hashManagementToken(result.managementToken),
    );
    expect(JSON.stringify(log.finalizeBody)).not.toContain(result.managementToken);
  });

  it("uploads exact periodic-vs-frame-aligned evidence from CapFrameX JSON", async () => {
    const log: TransportLog = {};
    const result = await uploadCapture(
      fixtureFile("capframex/json/amd-sensordata2-real.json"),
      {
        game: "Benchmark Game",
        visibility: "unlisted",
        transport: mockTransport(log),
      },
    );

    expect(result.ok, JSON.stringify(result)).toBe(true);
    const manifest = createRunRequestSchema.parse(log.createBody).capabilityManifest!;
    expect(manifest.sensors.gpuLoadPct).toEqual({ present: true, frameAligned: false });
    expect(manifest.sensors.gpuPowerW).toEqual({ present: true, frameAligned: false });
    expect(manifest.sensors.cpuBusyMs).toEqual({ present: true, frameAligned: true });
    expect(manifest.sensors.gpuBusyMs).toEqual({ present: true, frameAligned: true });
  });

  it("sends parser-derived capability semantics and normalized methodology metadata (§16a/§16c)", async () => {
    const log: TransportLog = {};
    const result = await uploadCapture(fixtureFile("presentmon/v2-basic.csv"), {
      game: "Test Game",
      visibility: "unlisted",
      hardware: { resolution: "2560x1440" },
      methodology: {
        sceneType: "benchmark-scene",
        upscaler: "none",
        rayTracing: "off",
        framePacing: { vsync: false, vrr: true },
        hags: "unknown",
      },
      benchmarkSetId: BENCHMARK_SET_ID,
      benchmarkSetSecret: BENCHMARK_SET_SECRET,
      isWarmup: true,
      transport: mockTransport(log),
    });

    expect(result.ok, JSON.stringify(result)).toBe(true);
    const createBody = createRunRequestSchema.parse(log.createBody);
    expect(createBody.capabilityManifest).toMatchObject({
      source: "presentmon",
      presentationMode: "hardware-independent-flip",
      syncMode: "tearing",
    });
    expect(createBody.methodologyManifest).toMatchObject({
      resolution: "2560x1440",
      captureProfile: "presentmon-2.x",
      frameGeneration: "none",
      hags: "unknown",
    });
    // The fixture's Runtime is DXGI, which names the present runtime rather than
    // the graphics API, so no API is claimed from it.
    expect(createBody.methodologyManifest?.graphicsApi).toBeUndefined();
    expect(createBody).toMatchObject({
      benchmarkSetId: BENCHMARK_SET_ID,
      benchmarkSetSecret: BENCHMARK_SET_SECRET,
      isWarmup: true,
    });
  });

  it("keeps a declared resolution when PresentMon has no hardware inventory", async () => {
    const log: TransportLog = {};
    const result = await uploadCapture(fixtureFile("presentmon/v2-basic.csv"), {
      game: "Test Game",
      visibility: "unlisted",
      methodology: {
        sceneType: "benchmark-scene",
        resolution: "2560x1440",
        upscaler: "none",
        rayTracing: "off",
        framePacing: { vsync: false, vrr: false },
      },
      transport: mockTransport(log),
    });

    expect(result.ok, JSON.stringify(result)).toBe(true);
    expect(createRunRequestSchema.parse(log.createBody).methodologyManifest?.resolution).toBe(
      "2560x1440",
    );
  });

  it("keeps a declared VSync state and reports detected sync as capture semantics", async () => {
    const log: TransportLog = {};
    const result = await uploadCapture(vsyncPresentMonFile(), {
      game: "Test Game",
      visibility: "unlisted",
      methodology: {
        sceneType: "benchmark-scene",
        upscaler: "none",
        rayTracing: "off",
        framePacing: { vsync: false, vrr: false },
      },
      transport: mockTransport(log),
    });

    expect(result.ok, JSON.stringify(result)).toBe(true);
    const body = createRunRequestSchema.parse(log.createBody);
    // Sync detection reads ONE present row, which routinely reports
    // SyncInterval=1 while the swapchain settles. It is real capture evidence
    // and belongs on the capability manifest — but `vsync` is a comparability
    // column, so overwriting the declaration would silently split this run out
    // of its own benchmark set on a single unlucky first frame.
    expect(body.capabilityManifest?.syncMode).toBe("vsync");
    expect(body.methodologyManifest?.framePacing.vsync).toBe(false);
  });

  it("round trip: the uploaded parquet recomputes to the exact client summary (§11.5 basis)", async () => {
    const log: TransportLog = {};
    const result = await uploadCapture(fixtureFile("capframex/csv/nvidia-full-sensors.csv"), {
      game: "Cyberpunk 2077",
      visibility: "unlisted",
      transport: mockTransport(log),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }

    const bytes = log.putBytes!;
    const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    const rows = await parquetReadObjects({ file: buffer as ArrayBuffer });
    const frames = rowsToFrameSamples(rows);
    // Bit-identical, not merely within tolerance.
    expect(computeRunSummary(frames)).toEqual(result.summary);
  });

  it("detects PresentMon and MangoHud sources too", async () => {
    for (const [fixture, source] of [
      ["presentmon/v2-basic.csv", "presentmon"],
      ["mangohud/nvidia-basic.csv", "mangohud"],
    ] as const) {
      const result = await uploadCapture(fixtureFile(fixture), {
        game: "Test Game",
        visibility: "unlisted",
        transport: mockTransport({}),
      });
      expect(result.ok, `${fixture}: ${JSON.stringify(result)}`).toBe(true);
      if (result.ok) {
        expect(result.captureSource).toBe(source);
      }
    }
  });

  it("preserves generated frames when the capture cannot identify the technology", async () => {
    const log: TransportLog = {};
    const result = await uploadCapture(generatedPresentMonFile(), {
      game: "Test Game",
      visibility: "unlisted",
      transport: mockTransport(log),
    });

    expect(result.ok, JSON.stringify(result)).toBe(true);
    const createBody = createRunRequestSchema.parse(log.createBody);
    expect(createBody.summary.generatedFramePct).toBeGreaterThan(0);
    expect(createBody.generatedFrameTech).toBe("unknown");
  });

  it("malformed input fails typed, before any network call (12.1)", async () => {
    const log: TransportLog = {};
    const transport = mockTransport(log);
    for (const fixture of [
      "malformed/binary-garbage.bin",
      "malformed/header-only.csv",
      "malformed/empty.csv",
    ]) {
      const result = await uploadCapture(fixtureFile(fixture), {
        game: "Test Game",
        visibility: "unlisted",
        transport,
      });
      expect(result.ok, fixture).toBe(false);
    }
    expect(transport.fetch).not.toHaveBeenCalled();
    expect(transport.putWithProgress).not.toHaveBeenCalled();
  });

  it("rejects an oversized raw capture before allocating its bytes", async () => {
    const arrayBuffer = vi.fn();
    const file = {
      size: INGEST_LIMITS.maxCaptureBytes + 1,
      arrayBuffer,
    } as unknown as File;
    const transport = mockTransport({});

    await expect(
      uploadCapture(file, { game: "Test Game", visibility: "unlisted", transport }),
    ).resolves.toMatchObject({ ok: false, code: "capture-too-large" });
    expect(arrayBuffer).not.toHaveBeenCalled();
    expect(transport.fetch).not.toHaveBeenCalled();
    expect(transport.putWithProgress).not.toHaveBeenCalled();
  });

  it("surfaces server error envelopes as typed failures", async () => {
    const log: TransportLog = {};
    const rejected = await uploadCapture(fixtureFile("capframex/csv/nvidia-full-sensors.csv"), {
      game: "Test Game",
      visibility: "unlisted",
      transport: mockTransport({}, { createStatus: 429 }),
    });
    expect(rejected).toMatchObject({ ok: false, code: "rate-limited" });

    const finalizeFailed = await uploadCapture(
      fixtureFile("capframex/csv/nvidia-full-sensors.csv"),
      {
        game: "Test Game",
        visibility: "unlisted",
        transport: mockTransport(log, { finalizeStatus: 409 }),
      },
    );
    expect(finalizeFailed).toMatchObject({ ok: false, code: "object-missing" });
    if (!finalizeFailed.ok) {
      expect(finalizeFailed.recovery).toBeUndefined();
    }
  });

  it("keeps recovery details when a finalize response may have been lost", async () => {
    const log: TransportLog = {};
    const result = await uploadCapture(fixtureFile("capframex/csv/nvidia-full-sensors.csv"), {
      game: "Test Game",
      visibility: "unlisted",
      transport: mockTransport(log, { finalizeError: new Error("finalize response timed out") }),
    });

    expect(result).toMatchObject({ ok: false, code: "upload-failed" });
    if (!result.ok) {
      await expectFinalizeRecovery(result, log);
    }
  });

  it("keeps recovery details for ambiguous finalize 5xx responses", async () => {
    const log: TransportLog = {};
    const result = await uploadCapture(fixtureFile("capframex/csv/nvidia-full-sensors.csv"), {
      game: "Test Game",
      visibility: "unlisted",
      transport: mockTransport(log, { finalizeStatus: 503 }),
    });

    expect(result).toMatchObject({ ok: false, code: "internal" });
    if (!result.ok) {
      await expectFinalizeRecovery(result, log);
    }
  });

  it("a failing PUT is a typed failure, not a throw (§11.8 batch safety)", async () => {
    const transport = mockTransport({});
    vi.mocked(transport.putWithProgress).mockRejectedValueOnce(new Error("network dropped"));
    const result = await uploadCapture(fixtureFile("capframex/csv/nvidia-full-sensors.csv"), {
      game: "Test Game",
      visibility: "unlisted",
      transport,
    });
    expect(result).toMatchObject({ ok: false, code: "upload-failed" });
  });
});

/**
 * Host-agnostic entry point (§22.1): the desktop client hands the engine raw
 * PresentMon CSV bytes and a signer, with no `File` anywhere in the flow.
 */
describe("uploadCaptureBytes (desktop entry point)", () => {
  function fixtureBytes(relative: string): Uint8Array {
    return new Uint8Array(readFileSync(path.join(FIXTURES, relative)));
  }

  it("accepts raw bytes and produces the same create payload as uploadCapture", async () => {
    const fromBytes: TransportLog = {};
    const fromFile: TransportLog = {};
    const relative = "capframex/csv/nvidia-full-sensors.csv";
    const options = { game: "Test Game", visibility: "unlisted" } as const;

    const bytesResult = await uploadCaptureBytes(fixtureBytes(relative), {
      ...options,
      transport: mockTransport(fromBytes),
    });
    const fileResult = await uploadCapture(fixtureFile(relative), {
      ...options,
      transport: mockTransport(fromFile),
    });

    expect(bytesResult.ok, JSON.stringify(bytesResult)).toBe(true);
    expect(fileResult.ok).toBe(true);
    expect(fromBytes.createBody).toEqual(fromFile.createBody);
    expect(fromBytes.putBytes).toEqual(fromFile.putBytes);
  });

  it("signs the exact Parquet bytes it PUTs, before the create request (§22.3)", async () => {
    const log: TransportLog = {};
    const order: string[] = [];
    let signed: Uint8Array | undefined;
    const transport = mockTransport(log);
    const fetchSpy = vi.mocked(transport.fetch);

    const result = await uploadCaptureBytes(fixtureBytes("presentmon/v2-basic.csv"), {
      game: "Test Game",
      visibility: "unlisted",
      hardware: { gpu: "Radeon RX 7900 XTX", cpu: "Ryzen 7 7800X3D" },
      transport,
      signPayload: async (parquet) => {
        order.push("sign");
        // Copy: the caller must not depend on the buffer staying live.
        signed = parquet.slice();
        return "c2lnbmF0dXJl";
      },
      onProgress: (p) => {
        if (p.stage === "creating") order.push("creating");
      },
    });

    expect(result.ok, JSON.stringify(result)).toBe(true);
    expect(order).toEqual(["sign", "creating"]);
    expect(signed).toEqual(log.putBytes);
    expect(finalizeRunRequestSchema.parse(log.finalizeBody).signature).toBe("c2lnbmF0dXJl");
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("omits the signature field entirely when the signer declines", async () => {
    const log: TransportLog = {};
    const result = await uploadCaptureBytes(fixtureBytes("presentmon/v2-basic.csv"), {
      game: "Test Game",
      visibility: "unlisted",
      transport: mockTransport(log),
      signPayload: async () => undefined,
    });

    expect(result.ok, JSON.stringify(result)).toBe(true);
    expect(log.finalizeBody).not.toHaveProperty("signature");
  });

  it("declares unknown, not none, when the capture cannot report frame type", async () => {
    const log: TransportLog = {};
    // CapFrameX carries no frame-type column at all, so nothing is known.
    // Saying `none` here would assert absence from absence of evidence — the
    // bug that let a frame-generated run report at twice its real rate.
    await uploadCaptureBytes(fixtureBytes("capframex/csv/nvidia-full-sensors.csv"), {
      game: "Test Game",
      visibility: "unlisted",
      transport: mockTransport(log),
    });
    expect(createRunRequestSchema.parse(log.createBody).generatedFrameTech).toBe("unknown");
  });

  it("passes the uploader's declaration through when there is no evidence", async () => {
    const log: TransportLog = {};
    await uploadCaptureBytes(fixtureBytes("capframex/csv/nvidia-full-sensors.csv"), {
      game: "Test Game",
      visibility: "unlisted",
      frameGeneration: "fsr3",
      transport: mockTransport(log),
    });
    expect(createRunRequestSchema.parse(log.createBody).generatedFrameTech).toBe("fsr3");
  });

  it("lets the frames overrule a declaration when the format DOES report frame type", async () => {
    const log: TransportLog = {};
    // v2-basic has a FrameType column reading `Application` throughout, so
    // "not generated" is an observation and the declaration must not win.
    await uploadCaptureBytes(fixtureBytes("presentmon/v2-basic.csv"), {
      game: "Test Game",
      visibility: "unlisted",
      frameGeneration: "fsr3",
      transport: mockTransport(log),
    });
    expect(createRunRequestSchema.parse(log.createBody).generatedFrameTech).toBe("none");
  });

  it("a signer failure is a typed failure, not a throw", async () => {
    const result = await uploadCaptureBytes(fixtureBytes("presentmon/v2-basic.csv"), {
      game: "Test Game",
      visibility: "unlisted",
      transport: mockTransport({}),
      signPayload: async () => {
        throw new Error("signing key unavailable");
      },
    });
    expect(result).toMatchObject({ ok: false, code: "upload-failed" });
  });
});
