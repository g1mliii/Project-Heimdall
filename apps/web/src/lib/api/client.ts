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

import {
  INGEST_LIMITS,
  framesUrlResponseSchema,
  rowsToFrameSamples,
  runResponseSchema,
} from "@heimdall/shared";
import type { FrameSample, FramesUrlResponse, RunResponse } from "@heimdall/shared";

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

/** Server error envelope → typed failure (falls back to transport-level codes). */
async function failureFromResponse<T>(response: Response, fallback: string): Promise<ApiResult<T>> {
  try {
    const body = (await response.json()) as { error?: { code?: string; message?: string } };
    if (body?.error?.code) {
      return failure(body.error.code, body.error.message ?? fallback);
    }
  } catch {
    // Non-JSON error body — fall through.
  }
  return failure(`http-${response.status}`, fallback);
}

async function getJson<T>(
  path: string,
  parse: (body: unknown) => T,
  fallback: string,
  transport: ApiTransport,
): Promise<ApiResult<T>> {
  let response: Response;
  try {
    response = await transport.fetch(path);
  } catch (error) {
    return failure("network", error instanceof Error ? error.message : String(error));
  }
  if (!response.ok) return failureFromResponse(response, fallback);
  try {
    return { ok: true, data: parse(await response.json()) };
  } catch (error) {
    return failure("invalid-response", error instanceof Error ? error.message : String(error));
  }
}

/** `GET /api/runs/:id` — the run row (metadata + summary + hardware). */
export function getRun(
  id: string,
  transport: ApiTransport = defaultTransport(),
): Promise<ApiResult<RunResponse>> {
  return getJson(
    `/api/runs/${encodeURIComponent(id)}`,
    (body) => runResponseSchema.parse(body),
    "run fetch failed",
    transport,
  );
}

/**
 * `GET /api/runs/:id/frames` — short-lived signed R2 URL for the Parquet.
 * Surfaces the 409 `not-finalized` envelope code when frames aren't up yet.
 */
export function getFramesUrl(
  id: string,
  transport: ApiTransport = defaultTransport(),
): Promise<ApiResult<FramesUrlResponse>> {
  return getJson(
    `/api/runs/${encodeURIComponent(id)}/frames`,
    (body) => framesUrlResponseSchema.parse(body),
    "frames url fetch failed",
    transport,
  );
}

/** Fetch the signed Parquet URL and decode it into validated frames. */
export async function fetchFrames(
  url: string,
  transport: ApiTransport = defaultTransport(),
): Promise<ApiResult<FrameSample[]>> {
  let response: Response;
  try {
    response = await transport.fetch(url);
  } catch (error) {
    return failure("network", error instanceof Error ? error.message : String(error));
  }
  if (!response.ok) return failure(`http-${response.status}`, "frames download failed");
  try {
    const buffer = await response.arrayBuffer();
    if (buffer.byteLength > INGEST_LIMITS.maxParquetBytes) {
      return failure("parquet-too-large", `frames object is ${buffer.byteLength} bytes`);
    }
    const { parquetReadObjects } = await import("hyparquet");
    const rows = await parquetReadObjects({ file: buffer });
    return { ok: true, data: rowsToFrameSamples(rows) };
  } catch (error) {
    return failure("invalid-response", error instanceof Error ? error.message : String(error));
  }
}

/** The full two-hop frames flow: signed URL → Parquet bytes → `FrameSample[]`. */
export async function loadRunFrames(
  id: string,
  transport: ApiTransport = defaultTransport(),
): Promise<ApiResult<FrameSample[]>> {
  const urlResult = await getFramesUrl(id, transport);
  if (!urlResult.ok) return urlResult;
  return fetchFrames(urlResult.data.url, transport);
}
