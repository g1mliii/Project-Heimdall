import { describe, expect, it } from "vitest";

import {
  MANAGEMENT_TOKEN_BYTES,
  generateManagementToken,
  hashManagementToken,
  verifyManagementToken,
} from "./tokens";

describe("management tokens", () => {
  it("verifies a freshly generated token against its stored hash", async () => {
    const token = generateManagementToken();
    expect(await verifyManagementToken(token, await hashManagementToken(token))).toBe(true);
  });

  it("never stores the plaintext (hash differs from token)", async () => {
    const token = generateManagementToken();
    expect(await hashManagementToken(token)).not.toBe(token);
  });

  it("hashes to a fixed-length lowercase hex digest", async () => {
    expect(await hashManagementToken("anything")).toMatch(/^[0-9a-f]{64}$/);
  });

  it("matches the well-known SHA-256 test vector (guards the WebCrypto path)", async () => {
    // sha256("abc") — FIPS 180-2 appendix B.1. If the hex encoding or digest
    // algorithm ever changed, every stored token hash would silently break.
    expect(await hashManagementToken("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });

  it("rejects a wrong token", async () => {
    const stored = await hashManagementToken(generateManagementToken());
    expect(await verifyManagementToken(generateManagementToken(), stored)).toBe(false);
  });

  it("is deterministic", async () => {
    const token = generateManagementToken();
    expect(await hashManagementToken(token)).toBe(await hashManagementToken(token));
  });

  it("returns false (does not throw) on a malformed stored hash", async () => {
    expect(await verifyManagementToken("anything", "not-hex!!")).toBe(false);
    expect(await verifyManagementToken("anything", "")).toBe(false);
    expect(await verifyManagementToken("anything", "abc")).toBe(false);
  });

  it("accepts an uppercase stored hash (legacy-tolerant compare)", async () => {
    const token = generateManagementToken();
    const stored = (await hashManagementToken(token)).toUpperCase();
    expect(await verifyManagementToken(token, stored)).toBe(true);
  });

  it("generates high-entropy unique tokens", () => {
    const a = generateManagementToken();
    const b = generateManagementToken();
    expect(a).not.toBe(b);
    // 32 bytes base64url-encoded ~ 43 chars.
    expect(a.length).toBeGreaterThanOrEqual(Math.ceil((MANAGEMENT_TOKEN_BYTES * 4) / 3) - 2);
    expect(a).toMatch(/^[A-Za-z0-9_-]+$/);
  });
});
