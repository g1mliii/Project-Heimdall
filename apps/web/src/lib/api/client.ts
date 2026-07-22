/**
 * Typed browser API client — the one place raw `fetch` + response parsing
 * lives, so components never scatter transport and validation logic.
 *
 * Follows the upload-engine conventions (lib/upload/upload-run.ts): never
 * throws, every outcome is a typed result union, responses are validated with
 * the shared zod schemas, and the transport is injectable so tests run in
 * Node. Frames arrive as a signed R2 Parquet URL (two-hop: §11.6), decoded
 * Run frames use `hyparquet` via dynamic import so that reader stays off
 * search and game pages.
 */

import {
  INGEST_LIMITS,
  framesUrlResponseSchema,
  gameDistributionResponseSchema,
  gameSubmissionsPageSchema,
  searchResponseSchema,
} from "@heimdall/shared";
import type {
  CreateReportRequest,
  FramesUrlResponse,
  GameDistributionQuery,
  GameDistributionResponse,
  GameSubmissionsPage,
  GameSubmissionsQuery,
  GrantVerificationRequest,
  RunVisibility,
  SearchResponse,
  UpdateReportRequest,
} from "@heimdall/shared";
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

function transportFetch(transport: ApiTransport, input: RequestInfo | URL, init?: RequestInit) {
  return init === undefined ? transport.fetch(input) : transport.fetch(input, init);
}

function signalInit(signal?: AbortSignal): RequestInit | undefined {
  return signal === undefined ? undefined : { signal };
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
    response = await transportFetch(transport, path, signalInit(signal));
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
 * Mutation half of {@link getJson}. Success bodies are deliberately discarded:
 * every mutation route in the app answers either 204/202-empty or with a body
 * the caller already has (`{ id, visibility }` echoes the request), so the
 * useful half of the response is the failure envelope — which components must
 * not re-derive from a bare status code.
 */
async function sendJson(
  path: string,
  method: "POST" | "PATCH" | "DELETE",
  body: unknown,
  fallback: string,
  transport: ApiTransport,
): Promise<ApiResult<void>> {
  const init: RequestInit =
    body === undefined
      ? { method }
      : { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) };
  let response: Response;
  try {
    response = await transportFetch(transport, path, init);
  } catch (error) {
    return failure("network", error instanceof Error ? error.message : String(error));
  }
  if (!response.ok) {
    const apiFailure = await readApiFailure(response, fallback);
    return failure(apiFailure.code, apiFailure.message);
  }
  return { ok: true, data: undefined };
}

/** `PATCH /api/runs/:id` — owner-only visibility switcher (§20.2). */
export function updateRunVisibility(
  id: string,
  visibility: RunVisibility,
  transport: ApiTransport = defaultTransport(),
): Promise<ApiResult<void>> {
  return sendJson(
    `/api/runs/${encodeURIComponent(id)}`,
    "PATCH",
    { visibility },
    "couldn't update visibility",
    transport,
  );
}

/** `DELETE /api/runs/:id` — owner/token-holder delete; drops the R2 frames too (§20.2). */
export function deleteRun(
  id: string,
  transport: ApiTransport = defaultTransport(),
): Promise<ApiResult<void>> {
  return sendJson(
    `/api/runs/${encodeURIComponent(id)}`,
    "DELETE",
    undefined,
    "couldn't delete that run",
    transport,
  );
}

/** `POST /api/account/delete` — right-to-erasure request; the cascade is async (§20.4). */
export function deleteAccount(
  transport: ApiTransport = defaultTransport(),
): Promise<ApiResult<void>> {
  return sendJson(
    "/api/account/delete",
    "POST",
    undefined,
    "couldn't delete your account",
    transport,
  );
}

/** `POST /api/reports` — anonymous-allowed content report (§20.5). */
export function createReport(
  report: CreateReportRequest,
  transport: ApiTransport = defaultTransport(),
): Promise<ApiResult<void>> {
  return sendJson("/api/reports", "POST", report, "couldn't submit that report", transport);
}

/** `POST /api/admin/verifications` — grant the verified-reviewer tier (§20.3). */
export function grantVerification(
  request: GrantVerificationRequest,
  transport: ApiTransport = defaultTransport(),
): Promise<ApiResult<void>> {
  return sendJson(
    "/api/admin/verifications",
    "POST",
    request,
    "couldn't grant verified reviewer",
    transport,
  );
}

/** `PATCH /api/admin/games/:id` — admin display-name fix (§20.5). */
export function renameGame(
  id: string,
  name: string,
  transport: ApiTransport = defaultTransport(),
): Promise<ApiResult<void>> {
  return sendJson(
    `/api/admin/games/${encodeURIComponent(id)}`,
    "PATCH",
    { name },
    "couldn't rename that game",
    transport,
  );
}

/** `PATCH /api/admin/reports/:id` — resolve or dismiss a queued report (§20.5). */
export function updateReportStatus(
  id: string,
  status: UpdateReportRequest["status"],
  transport: ApiTransport = defaultTransport(),
): Promise<ApiResult<void>> {
  return sendJson(
    `/api/admin/reports/${encodeURIComponent(id)}`,
    "PATCH",
    { status },
    "couldn't update that report",
    transport,
  );
}

/** `POST /api/admin/runs/:id/moderate` — moderator takedown; resolves the run's reports (§20.5). */
export function moderateRun(
  runId: string,
  transport: ApiTransport = defaultTransport(),
): Promise<ApiResult<void>> {
  return sendJson(
    `/api/admin/runs/${encodeURIComponent(runId)}/moderate`,
    "POST",
    undefined,
    "couldn't hide that run",
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
    response = await transportFetch(transport, url, signalInit(signal));
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

/** Bounded individual-run page for the game discovery screen (§17.7). */
export function loadGameRuns(
  slug: string,
  options: GameSubmissionsQuery,
  transport: ApiTransport = defaultTransport(),
  signal?: AbortSignal,
): Promise<ApiResult<GameSubmissionsPage>> {
  const query = new URLSearchParams({ limit: String(options.limit) });
  if (options.cursor) query.set("cursor", options.cursor);
  if (options.sceneType) query.set("sceneType", options.sceneType);
  if (options.sortDirection) query.set("sortDirection", options.sortDirection);
  return getJson(
    `/api/games/${encodeURIComponent(slug)}/runs?${query}`,
    (body) => gameSubmissionsPageSchema.parse(body),
    "game submissions fetch failed",
    transport,
    signal,
  );
}

/** Aggregate cohort distribution for a game + metric (§17). */
export function loadGameDistribution(
  slug: string,
  options: GameDistributionQuery,
  transport: ApiTransport = defaultTransport(),
  signal?: AbortSignal,
): Promise<ApiResult<GameDistributionResponse>> {
  const query = new URLSearchParams({ metric: options.metric });
  if (options.gpuId) query.set("gpuId", options.gpuId);
  if (options.sceneType) query.set("sceneType", options.sceneType);
  if (options.resolution) query.set("resolution", options.resolution);
  if (options.settingsPreset) query.set("settingsPreset", options.settingsPreset);
  if (options.upscaler) query.set("upscaler", options.upscaler);
  if (options.rayTracing) query.set("rayTracing", options.rayTracing);
  if (options.viewerRunId) query.set("viewerRunId", options.viewerRunId);
  if (options.verifiedOnly) query.set("verifiedOnly", "true");
  return getJson(
    `/api/games/${encodeURIComponent(slug)}/distribution?${query}`,
    (body) => gameDistributionResponseSchema.parse(body),
    "distribution fetch failed",
    transport,
    signal,
  );
}

/** Debounced global catalog typeahead (§17.6). */
export function loadCatalogSearch(
  query: string,
  transport: ApiTransport = defaultTransport(),
  signal?: AbortSignal,
): Promise<ApiResult<SearchResponse>> {
  const params = new URLSearchParams({ q: query });
  return getJson(
    `/api/search?${params}`,
    (body) => searchResponseSchema.parse(body),
    "catalog search failed",
    transport,
    signal,
  );
}
