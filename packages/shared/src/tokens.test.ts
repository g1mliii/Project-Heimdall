import { describe, expect, it } from "vitest";

import {
  MANAGEMENT_TOKEN_BYTES,
  generateManagementToken,
  hashManagementToken,
  verifyManagementToken,
} from "./tokens";

describe("management tokens", () => {
  it("verifies a freshly generated token against its stored hash", () => {
    const token = generateManagementToken();
    expect(verifyManagementToken(token, hashManagementToken(token))).toBe(true);
  });

  it("never stores the plaintext (hash differs from token)", () => {
    const token = generateManagementToken();
    expect(hashManagementToken(token)).not.toBe(token);
  });

  it("hashes to a fixed-length lowercase hex digest", () => {
    expect(hashManagementToken("anything")).toMatch(/^[0-9a-f]{64}$/);
  });

  it("rejects a wrong token", () => {
    const stored = hashManagementToken(generateManagementToken());
    expect(verifyManagementToken(generateManagementToken(), stored)).toBe(false);
  });

  it("is deterministic", () => {
    const token = generateManagementToken();
    expect(hashManagementToken(token)).toBe(hashManagementToken(token));
  });

  it("returns false (does not throw) on a malformed stored hash", () => {
    expect(verifyManagementToken("anything", "not-hex!!")).toBe(false);
    expect(verifyManagementToken("anything", "")).toBe(false);
    expect(verifyManagementToken("anything", "abc")).toBe(false);
  });

  it("generates high-entropy unique tokens", () => {
    const a = generateManagementToken();
    const b = generateManagementToken();
    expect(a).not.toBe(b);
    // 32 bytes base64url-encoded ~ 43 chars.
    expect(a.length).toBeGreaterThanOrEqual(Math.ceil((MANAGEMENT_TOKEN_BYTES * 4) / 3) - 2);
  });
});
