import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Anonymous management/delete tokens (IMPLEMENTATION_PLAN §1.2).
 *
 * An anonymous uploader gets a one-time plaintext token, shown ONCE. The server
 * persists ONLY its hash — the plaintext is never stored, so a DB leak cannot be
 * used to delete or manage runs. Verification is constant-time.
 * See docs/integrity-and-privacy.md §4.
 */

/** Bytes of entropy in a management token (256-bit). */
export const MANAGEMENT_TOKEN_BYTES = 32;

/** Generate a fresh, URL-safe plaintext management token. Show once; never store. */
export function generateManagementToken(): string {
  return randomBytes(MANAGEMENT_TOKEN_BYTES).toString("base64url");
}

/** Hash a token for at-rest storage. Deterministic and non-reversible. */
export function hashManagementToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/**
 * Constant-time check of a presented plaintext token against a stored hash.
 * Returns false (never throws) on any malformed stored hash.
 */
export function verifyManagementToken(token: string, storedHash: string): boolean {
  if (storedHash.length % 2 !== 0 || !/^[0-9a-f]+$/i.test(storedHash)) {
    return false;
  }
  const presented = Buffer.from(hashManagementToken(token), "hex");
  const expected = Buffer.from(storedHash, "hex");
  if (presented.length !== expected.length) {
    return false;
  }
  return timingSafeEqual(presented, expected);
}
