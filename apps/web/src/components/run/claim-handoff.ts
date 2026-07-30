/**
 * Desktop claim-token custody (§22.5).
 *
 * New desktop clients put the plaintext token in the URL fragment, which is
 * never sent in an HTTP request or Referer header. The first client render
 * moves it into tab-scoped storage and scrubs the address bar immediately.
 * Legacy `?claim=` links are still consumed, but are scrubbed by the same path.
 */

const STORAGE_PREFIX = "heimdall:claim:";
const FRAGMENT_PREFIX = "#claim=";

function storageKey(runId: string): string {
  return `${STORAGE_PREFIX}${runId}`;
}

function decode(value: string | null): string | undefined {
  if (!value) return undefined;
  try {
    const decoded = decodeURIComponent(value);
    return decoded === "" ? undefined : decoded;
  } catch {
    return undefined;
  }
}

function store(runId: string, token: string): void {
  try {
    window.sessionStorage.setItem(storageKey(runId), token);
  } catch {
    // Storage can be disabled. The caller still keeps the token in React state
    // for this render; losing it on navigation is safer than restoring it to
    // the address bar.
  }
}

function readStored(runId: string): string | undefined {
  try {
    return window.sessionStorage.getItem(storageKey(runId)) ?? undefined;
  } catch {
    return undefined;
  }
}

export function consumeClaimHandoff(runId: string, claimable: boolean): string | undefined {
  const url = new URL(window.location.href);
  const fragmentToken = url.hash.startsWith(FRAGMENT_PREFIX)
    ? decode(url.hash.slice(FRAGMENT_PREFIX.length))
    : undefined;
  // URLSearchParams already percent-decodes query values exactly once.
  const queryToken = url.searchParams.get("claim") || undefined;
  const token = fragmentToken ?? queryToken;

  if (url.hash.startsWith(FRAGMENT_PREFIX) || url.searchParams.has("claim")) {
    url.hash = "";
    url.searchParams.delete("claim");
    window.history.replaceState(null, "", `${url.pathname}${url.search}`);
  }

  if (!claimable) {
    clearClaimHandoff(runId);
    return undefined;
  }
  if (token !== undefined) {
    store(runId, token);
    return token;
  }
  return readStored(runId);
}

export function clearClaimHandoff(runId: string): void {
  try {
    window.sessionStorage.removeItem(storageKey(runId));
  } catch {
    // Best-effort cleanup for browsers that disable storage.
  }
}

/** A share link must never carry a claim capability, including legacy links. */
export function canonicalShareUrl(input: string): string {
  const url = new URL(input);
  url.searchParams.delete("claim");
  if (url.hash.startsWith(FRAGMENT_PREFIX)) url.hash = "";
  return url.toString();
}
