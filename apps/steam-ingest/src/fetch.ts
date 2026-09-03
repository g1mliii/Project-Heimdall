import { readAllBounded } from "@heimdall/shared";

/**
 * Steam's own hosts, and only these. Same posture as the driver-curation
 * fetcher: a redirect that leaves the allowlist is an error, not a follow.
 */
export const STEAM_HOSTS = ["api.steampowered.com", "store.steampowered.com"] as const;

const DEFAULT_MAX_BYTES = 4 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_REDIRECTS = 3;

export interface SafeFetchOptions {
  allowedHosts?: readonly string[];
  fetchImpl?: typeof fetch;
  maxBytes?: number;
  timeoutMs?: number;
}

async function discardBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // Preserve the source/redirect error that caused the discard.
  }
}

/**
 * Allowlisted JSON fetch with a hard body cap and timeout.
 *
 * Returns `unknown` on purpose — Steam's store endpoints are undocumented and
 * change shape without notice, so every caller narrows explicitly in sources.ts
 * rather than trusting a cast. A malformed body must degrade one app, never
 * poison a batch.
 */
export async function fetchJson(
  url: string,
  {
    allowedHosts = STEAM_HOSTS,
    fetchImpl = fetch,
    maxBytes = DEFAULT_MAX_BYTES,
    timeoutMs = DEFAULT_TIMEOUT_MS,
  }: SafeFetchOptions = {},
): Promise<unknown> {
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
    for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects++) {
      response = await fetchImpl(current, {
        redirect: "manual",
        signal: abort.signal,
        headers: {
          accept: "application/json",
          "user-agent": "HeimdallSteamIngest/1.0 (+https://github.com/g1mliii/Project-Heimdall)",
        },
      });
      if (response.status < 300 || response.status >= 400) break;
      await discardBody(response);
      if (redirects === MAX_REDIRECTS) throw new Error("source exceeded redirect limit");
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
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Bounded-concurrency map that never rejects.
 *
 * Steam rate-limits by IP, and a Worker invocation has a finite subrequest
 * budget, so the poller walks its working set at a fixed width instead of
 * firing `Promise.all` over a thousand appids. Failures are returned per item
 * so one dead app cannot discard a whole batch of good samples.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<Array<{ ok: true; value: R } | { ok: false; error: unknown }>> {
  if (concurrency < 1) throw new Error("concurrency must be at least 1");
  const results = new Array<{ ok: true; value: R } | { ok: false; error: unknown }>(items.length);
  let next = 0;
  const runners = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    for (;;) {
      const index = next++;
      if (index >= items.length) return;
      try {
        results[index] = { ok: true, value: await worker(items[index]!, index) };
      } catch (error) {
        results[index] = { ok: false, error };
      }
    }
  });
  await Promise.all(runners);
  return results;
}
