/**
 * Client upload engine (§11.1–§11.4, §11.8): parse locally → provisional
 * summary → Parquet → POST /api/runs → direct-to-R2 PUT → finalize.
 *
 * Raw log files never transit the API. Never throws: every outcome is a typed
 * result, so the batch loop (§11.8) gets per-file success/failure for free.
 * Client-only module (XMLHttpRequest for upload progress) — the transport is
 * injectable so tests run it in Node.
 */

import { computeRunSummary, deriveCapabilityManifest, parseAnyCapture } from "@heimdall/parsers";
import type { ParseWarning } from "@heimdall/parsers";
import {
  CURRENT_SCHEMA_VERSION,
  GENERATED_FRAME_TECH,
  INGEST_LIMITS,
  METHODOLOGY_MANIFEST_VERSION,
  PARQUET_CONTENT_TYPE,
  UNKNOWN_HARDWARE,
  createRunResponseSchema,
  generateManagementToken,
  hashManagementToken,
  normalizeMethodologyManifest,
} from "@heimdall/shared";
import type {
  CaptureSource,
  CreateRunRequest,
  FinalizeRunRequest,
  HardwareSnapshot,
  MethodologyManifest,
  RunSummary,
} from "@heimdall/shared";
import { readApiFailure } from "../api/errors";
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

export interface UploadRecovery {
  /** The run that may have finalized before its response was lost. */
  runId: string;
  /** Plaintext delete token generated before the finalize request. */
  managementToken: string;
}

export interface UploadFailure {
  ok: false;
  /** Parser error code, API error code, or a transport-level code. */
  code: string;
  message: string;
  /** Present after the direct PUT when finalization may have committed. */
  recovery?: UploadRecovery;
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
  /** Optional declared setup details for reproducibility/comparability (§16c). */
  methodology?: Omit<MethodologyManifest, "version" | "frameGeneration">;
  /** Optional repeatable-run group; warm-ups are retained but excluded from its stats. */
  benchmarkSetId?: string;
  /** Browser-held capability authorizing membership of the opaque set id. */
  benchmarkSetSecret?: string;
  isWarmup?: boolean;
  onProgress?: (progress: UploadProgress) => void;
  transport?: UploadTransport;
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
  return { ok: false, ...(await readApiFailure(response, fallback)) };
}

export async function uploadCapture(file: File, options: UploadOptions): Promise<UploadResult> {
  const transport = options.transport ?? defaultTransport();
  const emit = options.onProgress ?? (() => {});
  const benchmarkSetId = options.benchmarkSetId?.trim() || undefined;
  const benchmarkSetSecret = options.benchmarkSetSecret?.trim() || undefined;
  let finalizeRecovery: UploadRecovery | undefined;

  if ((benchmarkSetId === undefined) !== (benchmarkSetSecret === undefined)) {
    return {
      ok: false,
      code: "benchmark-set-secret-required",
      message: "A benchmark set needs both its id and browser-held key.",
    };
  }

  if (file.size > INGEST_LIMITS.maxCaptureBytes) {
    return {
      ok: false,
      code: "capture-too-large",
      message: `capture is ${file.size} bytes (limit ${INGEST_LIMITS.maxCaptureBytes})`,
    };
  }

  try {
    emit({ stage: "parsing" });
    const bytes = new Uint8Array(await file.arrayBuffer());
    const parsed = parseAnyCapture(bytes, { maxFrames: INGEST_LIMITS.maxFramesPerRun });
    if (!parsed.ok) {
      return { ok: false, code: parsed.error.code, message: parsed.error.message };
    }
    const {
      frames,
      hardware: parsedHardware,
      parserVersion,
      captureSemantics,
      captureProfile,
      sensorAlignment,
    } = parsed.capture;

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

    // Spreads first, required fields last: `??` skips an explicitly-undefined
    // gpu/cpu key in the overrides, so the placeholder always survives (a
    // trailing spread would clobber it back to undefined and fail zod).
    const hardware: HardwareSnapshot = {
      ...parsedHardware,
      ...options.hardware,
      gpu: options.hardware?.gpu ?? parsedHardware?.gpu ?? UNKNOWN_HARDWARE.gpu,
      cpu: options.hardware?.cpu ?? parsedHardware?.cpu ?? UNKNOWN_HARDWARE.cpu,
    };

    const generatedFrameTech =
      summary.generatedFramePct > 0
        ? GENERATED_FRAME_TECH.unknown
        : GENERATED_FRAME_TECH.none;
    const capabilityManifest = deriveCapabilityManifest(
      frames,
      parsed.source,
      hardware,
      {
        ...captureSemantics,
        ...(sensorAlignment === undefined ? {} : { sensorAlignment }),
      },
    );
    // Parser-detected details win over a declaration: unlike a user's text
    // entry, the source header/profile is direct capture evidence. Everything
    // else remains explicitly declared and therefore optional.
    const detectedVsync =
      captureSemantics?.syncMode === "vsync"
        ? true
        : captureSemantics?.syncMode === "tearing"
          ? false
          : undefined;
    const normalizedMethodology = normalizeMethodologyManifest(
      options.methodology === undefined
        ? undefined
        : {
            version: METHODOLOGY_MANIFEST_VERSION,
            ...options.methodology,
            frameGeneration: generatedFrameTech,
          },
      hardware,
      generatedFrameTech,
    );
    const methodologyManifest: MethodologyManifest | undefined =
      normalizedMethodology === undefined
        ? undefined
        : {
            ...normalizedMethodology,
            ...(detectedVsync === undefined
              ? {}
              : { framePacing: { ...normalizedMethodology.framePacing, vsync: detectedVsync } }),
            ...(captureSemantics?.graphicsApi === undefined
              ? {}
              : { graphicsApi: captureSemantics.graphicsApi }),
            ...(captureProfile === undefined
              ? {}
              : { captureProfile }),
            ...(hardware.os === undefined ? {} : { os: hardware.os }),
            ...(hardware.gpuDriver === undefined ? {} : { gpuDriver: hardware.gpuDriver }),
            captureDurationSeconds: summary.durationSeconds,
          };
    emit({ stage: "creating" });
    const createRequest: CreateRunRequest = {
      game: options.game.trim(),
      captureSource: parsed.source,
      visibility: options.visibility,
      hardware,
      summary,
      // Capture formats expose whether a frame was generated, but not which
      // vendor technology produced it. Preserve that distinction explicitly.
      generatedFrameTech,
      parquetByteLength: parquet.byteLength,
      capabilityManifest,
      ...(methodologyManifest === undefined ? {} : { methodologyManifest }),
      ...(benchmarkSetId === undefined ? {} : { benchmarkSetId, benchmarkSetSecret }),
      isWarmup: benchmarkSetId === undefined ? false : (options.isWarmup ?? false),
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
      uploadObjectKey: created.uploadObjectKey,
      visibility: options.visibility,
      managementTokenHash: await hashManagementToken(managementToken),
    };
    finalizeRecovery = { runId: created.id, managementToken };
    const finalizeResponse = await transport.fetch(`/api/runs/${created.id}/finalize`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(finalizeRequest),
    });
    if (!finalizeResponse.ok) {
      const failure = await failureFromResponse(finalizeResponse, "finalize failed");
      // A 5xx can be emitted after the server commits but before its response
      // reaches the browser. Deterministic 4xx errors never expose a token.
      return finalizeResponse.status >= 500 ? { ...failure, recovery: finalizeRecovery } : failure;
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
      ...(finalizeRecovery === undefined ? {} : { recovery: finalizeRecovery }),
    };
  }
}
