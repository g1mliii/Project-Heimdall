const DEFAULT_MAX_BYTES = 2 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_REDIRECTS = 5;

export interface SafeFetchOptions {
  allowedHosts: readonly string[];
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

/** Fixed-source fetch with redirect-host validation, timeout, and a hard body cap. */
export async function fetchText(
  url: string,
  {
    allowedHosts,
    fetchImpl = fetch,
    maxBytes = DEFAULT_MAX_BYTES,
    timeoutMs = DEFAULT_TIMEOUT_MS,
  }: SafeFetchOptions,
): Promise<string> {
  const assertAllowed = (candidate: URL): void => {
    if (candidate.protocol !== "https:" || !allowedHosts.includes(candidate.hostname)) {
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
          accept: "application/json,text/html,application/xml,text/xml;q=0.9,*/*;q=0.1",
          "user-agent": "HeimdallDriverCuration/1.0 (+https://github.com/g1mliii/Project-Heimdall)",
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

    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel("source body too large");
        throw new Error(`source body exceeds ${maxBytes} bytes`);
      }
      chunks.push(value);
    }

    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } finally {
    clearTimeout(timer);
  }
}
