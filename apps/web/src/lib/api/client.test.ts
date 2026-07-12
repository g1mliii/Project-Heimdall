/**
 * Typed API client coverage (§13.5). Pure Node — the transport is injected;
 * the parquet round trip uses the SAME hyparquet-writer bytes the upload path
 * produces, so the run page provably decodes what uploads encode.
 */

import { describe, expect, it, vi } from "vitest";

vi.mock("hyparquet", async (importOriginal) => {
  const actual = await importOriginal<typeof import("hyparquet")>();
  return {
    ...actual,
    parquetMetadata: vi.fn(actual.parquetMetadata),
    parquetReadObjects: vi.fn(actual.parquetReadObjects),
  };
});

import { parquetMetadata, parquetReadObjects } from "hyparquet";
import { parquetWriteBuffer } from "hyparquet-writer";
import { framesToColumnData, INGEST_LIMITS, makeSyntheticFrames } from "@heimdall/shared";
import { fetchFrames, getFramesUrl, loadRunFrames, type ApiTransport } from "./client";
import { FRAME_CHART_PARQUET_COLUMN_NAMES } from "../parquet/frame-metadata";

function transportReturning(handler: (url: string) => Response | Promise<Response>): ApiTransport {
  return {
    fetch: vi.fn(async (input: RequestInfo | URL) => handler(String(input))) as unknown as
      typeof fetch,
  };
}

function parquetBytes(frames = makeSyntheticFrames({ seed: 3, count: 200 })): ArrayBuffer {
  return parquetWriteBuffer({ columnData: framesToColumnData(frames) });
}

describe("getFramesUrl", () => {
  it("returns the signed URL payload on 200", async () => {
    const transport = transportReturning(() =>
      Response.json({ url: "https://r2.example.test/get", expiresInSeconds: 3600 }),
    );
    const result = await getFramesUrl("run_x", transport);
    expect(result).toEqual({
      ok: true,
      data: { url: "https://r2.example.test/get", expiresInSeconds: 3600 },
    });
  });

  it("URL-encodes hostile ids", async () => {
    const transport = transportReturning(() =>
      Response.json({ error: { code: "not-found", message: "run not found" } }, { status: 404 }),
    );
    await getFramesUrl("../secrets", transport);
    expect(transport.fetch).toHaveBeenCalledWith("/api/runs/..%2Fsecrets/frames");
  });

  it("passes a cancellation signal to the request", async () => {
    const controller = new AbortController();
    const transport = transportReturning(() =>
      Response.json({ url: "https://r2.example.test/get", expiresInSeconds: 3600 }),
    );

    await getFramesUrl("run_x", transport, controller.signal);

    expect(transport.fetch).toHaveBeenCalledWith("/api/runs/run_x/frames", { signal: controller.signal });
  });

  it("surfaces not-finalized on 409", async () => {
    const transport = transportReturning(() =>
      Response.json(
        { error: { code: "not-finalized", message: "run has no uploaded frames yet" } },
        { status: 409 },
      ),
    );
    const result = await getFramesUrl("run_x", transport);
    expect(result).toMatchObject({ ok: false, code: "not-finalized" });
  });
});

describe("fetchFrames", () => {
  it("decodes only the frame fields needed by the chart", async () => {
    const frames = makeSyntheticFrames({ seed: 3, count: 200 });
    const transport = transportReturning(() => new Response(parquetBytes(frames)));
    const readObjects = vi.mocked(parquetReadObjects);
    readObjects.mockClear();
    const result = await fetchFrames("https://r2.example.test/get", transport);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data).toEqual(
        frames.map(({ timeMs, frameTimeMs, gpuLoadPct, vramUsedMb }) => ({
          timeMs,
          frameTimeMs,
          gpuLoadPct,
          vramUsedMb,
        })),
      );
    }
    expect(readObjects).toHaveBeenCalledWith(
      expect.objectContaining({ columns: FRAME_CHART_PARQUET_COLUMN_NAMES }),
    );
  });

  it("reports http-<status> when the signed URL rejects", async () => {
    const transport = transportReturning(() => new Response("denied", { status: 403 }));
    const result = await fetchFrames("https://r2.example.test/get", transport);
    expect(result).toMatchObject({ ok: false, code: "http-403" });
  });

  it("reports invalid-response on corrupt parquet bytes", async () => {
    const transport = transportReturning(() => new Response(new Uint8Array([1, 2, 3, 4])));
    const result = await fetchFrames("https://r2.example.test/get", transport);
    expect(result).toMatchObject({ ok: false, code: "invalid-response" });
  });

  it("rejects metadata with too many frames before decoding rows", async () => {
    const metadata = vi.mocked(parquetMetadata).mockReturnValue({
      num_rows: BigInt(INGEST_LIMITS.maxFramesPerRun + 1),
      row_groups: [],
    } as never);
    const readObjects = vi.mocked(parquetReadObjects);
    readObjects.mockClear();

    const result = await fetchFrames(
      "https://r2.example.test/get",
      transportReturning(() => new Response(parquetBytes())),
    );

    expect(result).toMatchObject({ ok: false, code: "invalid-response" });
    expect(readObjects).not.toHaveBeenCalled();
    metadata.mockRestore();
  });
});

describe("loadRunFrames", () => {
  it("composes the two hops end to end", async () => {
    const frames = makeSyntheticFrames({ seed: 3, count: 200 });
    const transport = transportReturning((url) =>
      url.startsWith("/api/")
        ? Response.json({ url: "https://r2.example.test/get", expiresInSeconds: 3600 })
        : new Response(parquetBytes(frames)),
    );
    const result = await loadRunFrames("run_x", transport);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data).toHaveLength(200);
  });

  it("passes a cancellation signal through both hops", async () => {
    const controller = new AbortController();
    const transport = transportReturning((url) =>
      url.startsWith("/api/")
        ? Response.json({ url: "https://r2.example.test/get", expiresInSeconds: 3600 })
        : new Response(parquetBytes()),
    );

    await loadRunFrames("run_x", transport, controller.signal);

    expect(transport.fetch).toHaveBeenNthCalledWith(
      1,
      "/api/runs/run_x/frames",
      { signal: controller.signal },
    );
    expect(transport.fetch).toHaveBeenNthCalledWith(
      2,
      "https://r2.example.test/get",
      { signal: controller.signal },
    );
  });

  it("short-circuits on a not-finalized first hop", async () => {
    const transport = transportReturning(() =>
      Response.json({ error: { code: "not-finalized", message: "wait" } }, { status: 409 }),
    );
    const result = await loadRunFrames("run_x", transport);
    expect(result).toMatchObject({ ok: false, code: "not-finalized" });
    expect(transport.fetch).toHaveBeenCalledTimes(1);
  });
});
