import { fetchAllowlistedText } from "@heimdall/shared";

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

/**
 * Allowlisted JSON fetch with a hard body cap and timeout.
 *
 * The redirect walk, allowlist re-check and bounded read are
 * `fetchAllowlistedText` in `@heimdall/shared` — the same hardening the
 * driver-curation poller runs, so a fix there cannot reach one worker and miss
 * this one. Only Steam's hosts, identity and limits live here.
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
    fetchImpl,
    maxBytes = DEFAULT_MAX_BYTES,
    timeoutMs = DEFAULT_TIMEOUT_MS,
  }: SafeFetchOptions = {},
): Promise<unknown> {
  return JSON.parse(
    await fetchAllowlistedText(url, {
      allowedHosts,
      accept: "application/json",
      userAgent: "HeimdallSteamIngest/1.0 (+https://github.com/g1mliii/Project-Heimdall)",
      fetchImpl,
      maxBytes,
      timeoutMs,
      maxRedirects: MAX_REDIRECTS,
    }),
  );
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
