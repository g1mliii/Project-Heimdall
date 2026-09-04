import { fetchAllowlistedText } from "@heimdall/shared";

const DEFAULT_MAX_BYTES = 2 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_REDIRECTS = 5;

export interface SafeFetchOptions {
  allowedHosts: readonly string[];
  fetchImpl?: typeof fetch;
  maxBytes?: number;
  timeoutMs?: number;
}

/**
 * Fixed-source fetch with redirect-host validation, timeout, and a hard body cap.
 *
 * The hardening itself is `fetchAllowlistedText` in `@heimdall/shared`, shared
 * with the other scheduled pollers so a fix to the redirect walk reaches all of
 * them. What stays here is this worker's own identity and limits.
 */
export async function fetchText(
  url: string,
  {
    allowedHosts,
    fetchImpl,
    maxBytes = DEFAULT_MAX_BYTES,
    timeoutMs = DEFAULT_TIMEOUT_MS,
  }: SafeFetchOptions,
): Promise<string> {
  return fetchAllowlistedText(url, {
    allowedHosts,
    accept: "application/json,text/html,application/xml,text/xml;q=0.9,*/*;q=0.1",
    userAgent: "HeimdallDriverCuration/1.0 (+https://github.com/g1mliii/Project-Heimdall)",
    fetchImpl,
    maxBytes,
    timeoutMs,
    maxRedirects: MAX_REDIRECTS,
  });
}
