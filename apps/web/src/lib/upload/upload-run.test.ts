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
  rowsToFrameSamples,
} from "@heimdall/shared";
import { uploadCapture, type UploadProgress, type UploadTransport } from "./upload-run";

const FIXTURES = path.resolve(
  import.meta.dirname,
  "../../../../../packages/parsers/fixtures",
);

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
      `game.exe,1234,0xAAAA,${i % 2 === 0 ? "Application" : "AMD AFMF"},${3.5 + i * 0.01},10`,
    );
  }
  return new File([lines.join("\n")], "presentmon-generated.csv");
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
  overrides: { createStatus?: number; finalizeStatus?: number } = {},
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
      if (overrides.finalizeStatus) {
        return Response.json(
          { error: { code: "object-missing", message: "upload first" } },
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

  it("surfaces server error envelopes as typed failures", async () => {
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
        transport: mockTransport({}, { finalizeStatus: 409 }),
      },
    );
    expect(finalizeFailed).toMatchObject({ ok: false, code: "object-missing" });
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
