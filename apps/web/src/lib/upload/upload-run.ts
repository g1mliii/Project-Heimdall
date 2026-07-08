/**
 * Client upload engine (§11.1–§11.4, §11.8): parse locally → provisional
 * summary → Parquet → POST /api/runs → direct-to-R2 PUT → finalize.
 *
 * Raw log files never transit the API. Never throws: every outcome is a typed
 * result, so the batch loop (§11.8) gets per-file success/failure for free.
 * Client-only module (XMLHttpRequest for upload progress) — the transport is
 * injectable so tests run it in Node.
 */

import { parseCapture, computeRunSummary } from "@heimdall/parsers";
import type { ParseError, ParseWarning, ParsedCapture } from "@heimdall/parsers";
import {
  CURRENT_SCHEMA_VERSION,
  INGEST_LIMITS,
  PARQUET_CONTENT_TYPE,
  createRunResponseSchema,
  generateManagementToken,
  hashManagementToken,
} from "@heimdall/shared";
import type {
  CaptureSource,
  CreateRunRequest,
  FinalizeRunRequest,
  HardwareSnapshot,
  RunSummary,
} from "@heimdall/shared";
import { buildFramesParquet } from "./build-parquet";

export type UploadProgress =
  | { stage: "parsing" }
  | { stage: "building-parquet"; frames: number }
  | { stage: "creating" }
  | { stage: "uploading"; sentBytes: number; totalBytes: number }
  | { stage: "finalizing" }
  | { stage: "done"; runId: string };

export interface UploadSuccess {
  ok: true;
  runId: string;
  /** Plaintext delete/management token — shown ONCE, never sent anywhere. */
  managementToken: string;
  captureSource: CaptureSource;
  summary: RunSummary;
  warnings: ParseWarning[];
}

export interface UploadFailure {
  ok: false;
  /** Parser error code, API error code, or a transport-level code. */
  code: string;
  message: string;
}

export type UploadResult = UploadSuccess | UploadFailure;

export interface UploadTransport {
  fetch: typeof fetch;
  /** PUT with upload progress; the default uses XMLHttpRequest (fetch can't). */
  putWithProgress(
    url: string,
    bytes: Uint8Array,
    contentType: string,
    onProgress: (sentBytes: number) => void,
  ): Promise<void>;
}

export interface UploadOptions {
  game: string;
  visibility: "unlisted" | "public";
  /** Overrides/completes hardware when the log carries none (PresentMon CSV). */
  hardware?: Partial<HardwareSnapshot>;
  onProgress?: (progress: UploadProgress) => void;
  transport?: UploadTransport;
}

const DEFAULT_DETECTION_ORDER: CaptureSource[] = ["capframex", "presentmon", "mangohud"];

/**
 * Source-distinctive markers. Necessary because the parsers' frame-time
 * columns overlap (MangoHud and PresentMon v2 both name it `frametime`;
 * CapFrameX CSV and PresentMon v1 both use `msbetweenpresents`) — blind
 * try-in-order would "succeed" with the wrong source label.
 */
const SOURCE_MARKERS: Record<CaptureSource, readonly string[]> = {
  capframex: ["msgpuactive", "gpumemusage", '"capturedata"', '"msbetweenpresents"'],
  presentmon: ["swapchainaddress", "presentruntime", "allowstearing", "cpustarttime"],
  mangohud: ["gpu_core_clock", "gpu_vram_used", "cpuscheduler", "cpu_load"],
};

/** Most marker hits in the file head goes first; ties keep the default order. */
function detectionOrder(input: Uint8Array): CaptureSource[] {
  const head = new TextDecoder().decode(input.subarray(0, 4096)).toLowerCase();
  const score = (source: CaptureSource) =>
    SOURCE_MARKERS[source].reduce((hits, marker) => hits + (head.includes(marker) ? 1 : 0), 0);
  return [...DEFAULT_DETECTION_ORDER].sort((a, b) => score(b) - score(a));
}

function detectAndParse(
  input: Uint8Array,
): { ok: true; source: CaptureSource; capture: ParsedCapture; warnings: ParseWarning[] } | {
  ok: false;
  error: ParseError;
} {
  let bestError: ParseError | null = null;
  for (const source of detectionOrder(input)) {
    const result = parseCapture(source, input);
    if (result.ok) {
      return { ok: true, source, capture: result.value, warnings: result.warnings };
    }
    // Keep the most informative rejection: a source that recognized the shape
    // but choked mid-file beats a blanket "unrecognized-format".
    if (!bestError || (bestError.code === "unrecognized-format" && result.error.code !== "unrecognized-format")) {
      bestError = result.error;
    }
  }
  return { ok: false, error: bestError! };
}

function defaultTransport(): UploadTransport {
  return {
    fetch: globalThis.fetch.bind(globalThis),
    putWithProgress(url, bytes, contentType, onProgress) {
      return new Promise<void>((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open("PUT", url);
        xhr.setRequestHeader("content-type", contentType);
        xhr.upload.onprogress = (event) => onProgress(event.loaded);
        xhr.onload = () =>
          xhr.status >= 200 && xhr.status < 300
            ? resolve()
            : reject(new Error(`storage PUT failed with status ${xhr.status}`));
        xhr.onerror = () => reject(new Error("storage PUT failed (network)"));
        // Send a fresh copy: some XHR implementations detach the buffer.
        xhr.send(bytes.slice());
      });
    },
  };
}

/** Server error envelope → typed failure (falls back to transport-level codes). */
async function failureFromResponse(response: Response, fallback: string): Promise<UploadFailure> {
  try {
    const body = (await response.json()) as { error?: { code?: string; message?: string } };
    if (body?.error?.code) {
      return { ok: false, code: body.error.code, message: body.error.message ?? fallback };
    }
  } catch {
    // Non-JSON error body — fall through.
  }
  return { ok: false, code: `http-${response.status}`, message: fallback };
}

export async function uploadCapture(file: File, options: UploadOptions): Promise<UploadResult> {
  const transport = options.transport ?? defaultTransport();
  const emit = options.onProgress ?? (() => {});

  try {
    emit({ stage: "parsing" });
    const bytes = new Uint8Array(await file.arrayBuffer());
    const parsed = detectAndParse(bytes);
    if (!parsed.ok) {
      return { ok: false, code: parsed.error.code, message: parsed.error.message };
    }
    const { frames, hardware: parsedHardware, parserVersion } = parsed.capture;

    // Fast local feedback for the same limits the server enforces (§11.10).
    if (frames.length > INGEST_LIMITS.maxFramesPerRun) {
      return {
        ok: false,
        code: "too-many-frames",
        message: `capture has ${frames.length} frames (limit ${INGEST_LIMITS.maxFramesPerRun})`,
      };
    }
    if (frames.length < INGEST_LIMITS.minFramesPerRun) {
      return {
        ok: false,
        code: "too-few-frames",
        message: `capture has only ${frames.length} frames (minimum ${INGEST_LIMITS.minFramesPerRun})`,
      };
    }

    const summary = computeRunSummary(frames);

    emit({ stage: "building-parquet", frames: frames.length });
    const parquet = await buildFramesParquet(frames);
    if (parquet.byteLength > INGEST_LIMITS.maxParquetBytes) {
      return {
        ok: false,
        code: "parquet-too-large",
        message: `frames encode to ${parquet.byteLength} bytes (limit ${INGEST_LIMITS.maxParquetBytes})`,
      };
    }

    const hardware: HardwareSnapshot = {
      gpu: options.hardware?.gpu ?? parsedHardware?.gpu ?? "Unknown GPU",
      cpu: options.hardware?.cpu ?? parsedHardware?.cpu ?? "Unknown CPU",
      ...parsedHardware,
      ...options.hardware,
    };

    emit({ stage: "creating" });
    const createRequest: CreateRunRequest = {
      game: options.game.trim(),
      captureSource: parsed.source,
      visibility: options.visibility,
      hardware,
      summary,
      generatedFrameTech: "none",
      parquetByteLength: parquet.byteLength,
      schemaVersion: CURRENT_SCHEMA_VERSION,
      parserVersion,
    };
    const createResponse = await transport.fetch("/api/runs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(createRequest),
    });
    if (!createResponse.ok) {
      return failureFromResponse(createResponse, "run creation failed");
    }
    const created = createRunResponseSchema.parse(await createResponse.json());

    emit({ stage: "uploading", sentBytes: 0, totalBytes: parquet.byteLength });
    await transport.putWithProgress(created.uploadUrl, parquet, PARQUET_CONTENT_TYPE, (sent) =>
      emit({ stage: "uploading", sentBytes: sent, totalBytes: parquet.byteLength }),
    );

    emit({ stage: "finalizing" });
    const managementToken = generateManagementToken();
    const finalizeRequest: FinalizeRunRequest = {
      framesObjectKey: created.framesObjectKey,
      visibility: options.visibility,
      managementTokenHash: await hashManagementToken(managementToken),
    };
    const finalizeResponse = await transport.fetch(`/api/runs/${created.id}/finalize`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(finalizeRequest),
    });
    if (!finalizeResponse.ok) {
      return failureFromResponse(finalizeResponse, "finalize failed");
    }

    emit({ stage: "done", runId: created.id });
    return {
      ok: true,
      runId: created.id,
      managementToken,
      captureSource: parsed.source,
      summary,
      warnings: parsed.warnings,
    };
  } catch (error) {
    return {
      ok: false,
      code: "upload-failed",
      message: error instanceof Error ? error.message : String(error),
    };
  }
}
