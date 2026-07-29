/**
 * Desktop `UploadTransport` for @heimdall/ingest-client (§22.5).
 *
 * The ingest engine is shared verbatim with the web hub; only the two
 * host-specific seams differ:
 *
 * * `fetch` — tauri-plugin-http, because the webview's CSP allows no remote
 *   origins. The engine calls relative paths (`/api/runs`), so this adapter
 *   resolves them against the build-time hub origin.
 * * `putWithProgress` — the presigned R2 PUT runs in Rust, which already holds
 *   the payload from `prepare_payload` and streams progress back as events.
 */

import { fetch as tauriFetch } from "@tauri-apps/plugin-http";
import type { UploadTransport } from "@heimdall/ingest-client";
import {
  EVENTS,
  on,
  preparePayload,
  putPreparedPayload,
  type PreparedPayload,
} from "./ipc";

interface UploadProgressEvent {
  sentBytes: number;
  totalBytes: number;
}

/** Absolute-ize the engine's relative API paths; pass absolute URLs through. */
export function resolveUrl(apiBaseUrl: string, input: string): string {
  return /^https?:\/\//i.test(input) ? input : `${apiBaseUrl.replace(/\/+$/, "")}${input}`;
}

export function createDesktopTransport(apiBaseUrl: string): UploadTransport {
  return {
    fetch: ((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? resolveUrl(apiBaseUrl, input) : input;
      return tauriFetch(url as string, init);
    }) as typeof fetch,

    async putWithProgress(url, _bytes, contentType, onProgress) {
      // `_bytes` are deliberately ignored: Rust took custody of the exact same
      // buffer in `prepare_payload` and uploads THOSE bytes, so the signature
      // and the uploaded object cannot drift apart. `url` and `contentType`
      // come from the engine — the presigned URL and the exact type it was
      // signed for — and are passed through unchanged, so `@heimdall/shared`
      // stays the only place that names the Parquet content type.
      const unlisten = await on<UploadProgressEvent>(EVENTS.uploadProgress, (progress) =>
        onProgress(progress.sentBytes),
      );
      try {
        await putPreparedPayload(url, contentType);
      } finally {
        unlisten();
      }
    },
  };
}

/**
 * `signPayload` hook for the ingest engine. Returning `undefined` when this
 * build carries no key is a valid outcome — the run uploads unsigned and the
 * server records `signature_valid: null` (§0.5).
 */
export function createSigner(): (parquet: Uint8Array) => Promise<string | undefined> {
  return async (parquet) => {
    const prepared: PreparedPayload = await preparePayload(parquet);
    return prepared.signature;
  };
}
