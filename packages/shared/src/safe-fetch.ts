/**
 * One allowlisted fetch, shared by every scheduled ingest worker.
 *
 * WHY THIS IS SHARED AND NOT COPIED. This is SSRF hardening, not convenience:
 * the redirect chain is walked by hand (`redirect: "manual"`) so that EVERY hop
 * is re-checked against the allowlist, not just the first — an upstream that
 * 302s to `http://169.254.169.254/` must be an error, never a follow. The body
 * is capped before and during the read, and a timeout aborts the whole chain.
 * Three workers poll third-party HTTP on a schedule (driver currency, Steam
 * catalog, and whatever comes next); a fix to any of that logic has to reach
 * all of them, which a copy in each app cannot do.
 *
 * Callers keep their own accept header, user-agent and limits, because those
 * are per-source facts, not security posture. `readAllBounded` lives beside
 * this for the same reason.
 */

import { readAllBounded } from "./stream";

const DEFAULT_MAX_BYTES = 2 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_REDIRECTS = 5;

export interface AllowlistedFetchOptions {
  /** Hostnames that may be reached, on the first request and on every hop. */
  allowedHosts: readonly string[];
  accept: string;
  userAgent: string;
  fetchImpl?: typeof fetch;
  maxBytes?: number;
  timeoutMs?: number;
  maxRedirects?: number;
}

async function discardBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // Preserve the source/redirect error that caused the discard.
  }
}

/** Fixed-source fetch with redirect-host validation, timeout, and a hard body cap. */
export async function fetchAllowlistedText(
  url: string,
  {
    allowedHosts,
    accept,
    userAgent,
    fetchImpl = fetch,
    maxBytes = DEFAULT_MAX_BYTES,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    maxRedirects = DEFAULT_MAX_REDIRECTS,
  }: AllowlistedFetchOptions,
): Promise<string> {
  const assertAllowed = (candidate: URL): void => {
    if (
      candidate.protocol !== "https:" ||
      candidate.port !== "" ||
      !allowedHosts.includes(candidate.hostname)
    ) {
      throw new Error(`source URL is not allowlisted: ${candidate.origin}`);
    }
  };
  const requested = new URL(url);
  assertAllowed(requested);
  if (maxBytes <= 0 || timeoutMs <= 0) {
    throw new Error("source fetch limits must be positive");
  }

  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(new Error("source fetch timed out")), timeoutMs);
  try {
    let current = requested;
    let response: Response | undefined;
    for (let redirects = 0; redirects <= maxRedirects; redirects++) {
      response = await fetchImpl(current, {
        redirect: "manual",
        signal: abort.signal,
        headers: { accept, "user-agent": userAgent },
      });
      if (response.status < 300 || response.status >= 400) break;
      await discardBody(response);
      if (redirects === maxRedirects) throw new Error("source exceeded redirect limit");
      const location = response.headers.get("location");
      if (!location) throw new Error("source redirect omitted location");
      current = new URL(location, current);
      assertAllowed(current);
    }
    if (!response) throw new Error("source returned no response");
    if (!response.ok) {
      await discardBody(response);
      throw new Error(`source returned HTTP ${response.status}`);
    }

    const declaredLength = Number(response.headers.get("content-length"));
    if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
      await discardBody(response);
      throw new Error(`source body exceeds ${maxBytes} bytes`);
    }
    if (!response.body) throw new Error("source returned no body");

    const bytes = await readAllBounded(response.body, maxBytes);
    if (bytes === null) throw new Error(`source body exceeds ${maxBytes} bytes`);
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Never let a connection string reach a persisted log.
 *
 * Every scheduled worker logs the errors it survives, and a Postgres driver is
 * happy to put the whole DSN — password included — into a message. Shared so
 * that widening the pattern protects every worker at once rather than the one
 * whose file someone happened to open.
 */
export function summariseError(error: unknown, fallback: string): string {
  if (!(error instanceof Error)) return fallback;
  return `${error.name}: ${error.message}`.replace(
    /postgres(?:ql)?:\/\/[^\s]+/gi,
    "[redacted database URL]",
  );
}

/** A DATABASE_URL that is actually a PostgreSQL connection string. */
export function assertDatabaseUrl(value: string): void {
  const url = new URL(value);
  if (!(["postgres:", "postgresql:"] as string[]).includes(url.protocol) || !url.hostname) {
    throw new Error("DATABASE_URL must be a PostgreSQL connection string");
  }
}
