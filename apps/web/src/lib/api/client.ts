/**
 * Typed browser API client for the run page (§13.5) — the one place raw
 * `fetch` + response parsing lives, so components never scatter it.
 *
 * Follows the upload-engine conventions (lib/upload/upload-run.ts): never
 * throws, every outcome is a typed result union, responses are validated with
 * the shared zod schemas, and the transport is injectable so tests run in
 * Node. Frames arrive as a signed R2 Parquet URL (two-hop: §11.6), decoded
 * with `hyparquet` via dynamic import so the reader stays off non-run pages.
 */

import { INGEST_LIMITS, framesUrlResponseSchema } from "@heimdall/shared";
import type { FramesUrlResponse } from "@heimdall/shared";
import { readApiFailure } from "./errors";
import { decodeFrameParquetToSeries } from "../parquet/frame-metadata";
import type { FrameSeries } from "../run/frame-series";

export type ApiResult<T> =
  | { ok: true; data: T }
  | {
      ok: false;
      /** Envelope code (`not-found`, `not-finalized`, …) or a transport-level
       * `http-<status>` / `network` / `invalid-response`. */
      code: string;
      message: string;
    };

export interface ApiTransport {
  fetch: typeof fetch;
}

function defaultTransport(): ApiTransport {
  return { fetch: globalThis.fetch.bind(globalThis) };
}

function failure<T>(code: string, message: string): ApiResult<T> {
  return { ok: false, code, message };
}

function transportFetch(transport: ApiTransport, input: RequestInfo | URL, signal?: AbortSignal) {
  return signal === undefined ? transport.fetch(input) : transport.fetch(input, { signal });
}

async function getJson<T>(
  path: string,
  parse: (body: unknown) => T,
  fallback: string,
  transport: ApiTransport,
  signal?: AbortSignal,
): Promise<ApiResult<T>> {
  let response: Response;
  try {
    response = await transportFetch(transport, path, signal);
  } catch (error) {
    return failure(signal?.aborted ? "aborted" : "network", error instanceof Error ? error.message : String(error));
  }
  if (!response.ok) {
    const apiFailure = await readApiFailure(response, fallback);
    return failure(apiFailure.code, apiFailure.message);
  }
  try {
    return { ok: true, data: parse(await response.json()) };
  } catch (error) {
    return failure("invalid-response", error instanceof Error ? error.message : String(error));
  }
}

/**
 * `GET /api/runs/:id/frames` — short-lived signed R2 URL for the Parquet.
 * Surfaces the 409 `not-finalized` envelope code when frames aren't up yet.
 */
export function getFramesUrl(
  id: string,
  transport: ApiTransport = defaultTransport(),
  signal?: AbortSignal,
): Promise<ApiResult<FramesUrlResponse>> {
  return getJson(
    `/api/runs/${encodeURIComponent(id)}/frames`,
    (body) => framesUrlResponseSchema.parse(body),
    "frames url fetch failed",
    transport,
    signal,
  );
}

/** Fetch the signed Parquet URL and decode it directly into chart columns. */
export async function fetchFrames(
  url: string,
  transport: ApiTransport = defaultTransport(),
  signal?: AbortSignal,
): Promise<ApiResult<FrameSeries>> {
  let response: Response;
  try {
    response = await transportFetch(transport, url, signal);
  } catch (error) {
    return failure(signal?.aborted ? "aborted" : "network", error instanceof Error ? error.message : String(error));
  }
  if (!response.ok) return failure(`http-${response.status}`, "frames download failed");
  try {
    const buffer = await response.arrayBuffer();
    if (signal?.aborted) return failure("aborted", "frames download was cancelled");
    if (buffer.byteLength > INGEST_LIMITS.maxParquetBytes) {
      return failure("parquet-too-large", `frames object is ${buffer.byteLength} bytes`);
    }
    return { ok: true, data: await decodeFrameParquetToSeries(buffer) };
  } catch (error) {
    return failure("invalid-response", error instanceof Error ? error.message : String(error));
  }
}

/** The full two-hop frames flow: signed URL → Parquet bytes → chart series. */
export async function loadRunFrames(
  id: string,
  transport: ApiTransport = defaultTransport(),
  signal?: AbortSignal,
): Promise<ApiResult<FrameSeries>> {
  const urlResult = await getFramesUrl(id, transport, signal);
  if (!urlResult.ok) return urlResult;
  return fetchFrames(urlResult.data.url, transport, signal);
}
