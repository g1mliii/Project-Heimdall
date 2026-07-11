/**
 * Anonymous management/delete tokens (IMPLEMENTATION_PLAN §1.2).
 *
 * An anonymous uploader gets a one-time plaintext token, shown ONCE. The server
 * persists ONLY its hash — the plaintext is never stored, so a DB leak cannot be
 * used to delete or manage runs. Verification is constant-time.
 * See docs/integrity-and-privacy.md §4.
 *
 * Isomorphic on purpose (WebCrypto, no `node:crypto`): the browser generates and
 * hashes the token during upload (§11.4) with the exact same code the server
 * uses to verify it — no dual implementation to drift. Requires a secure
 * context in browsers (localhost + https), which the upload page always has.
 */

/** Bytes of entropy in a management token (256-bit). */
export const MANAGEMENT_TOKEN_BYTES = 32;

/** Generate a fresh, URL-safe plaintext management token. Show once; never store. */
export function generateManagementToken(): string {
  const bytes = new Uint8Array(MANAGEMENT_TOKEN_BYTES);
  crypto.getRandomValues(bytes);
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Hash a token for at-rest storage. Deterministic and non-reversible. */
export async function hashManagementToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Constant-time check of a presented plaintext token against a stored hash.
 * Returns false (never throws) on any malformed stored hash.
 */
export async function verifyManagementToken(token: string, storedHash: string): Promise<boolean> {
  if (!/^[0-9a-f]{64}$/i.test(storedHash)) {
    return false;
  }
  const presented = await hashManagementToken(token);
  const expected = storedHash.toLowerCase();
  // XOR-accumulate over fixed-length hex digests — no early exit on mismatch.
  let diff = 0;
  for (let i = 0; i < presented.length; i++) {
    diff |= presented.charCodeAt(i) ^ expected.charCodeAt(i);
  }
  return diff === 0;
}
