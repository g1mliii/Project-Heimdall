/**
 * env.ts fail-fast behavior: a missing variable produces one clear error
 * naming every missing key, at first use (Phase 2).
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

describe("server env validation", () => {
  beforeEach(() => {
    vi.resetModules(); // drop the per-module env caches
    vi.unstubAllEnvs();
  });

  it("getDbEnv returns the URL when set", async () => {
    vi.stubEnv("DATABASE_URL", "postgresql://localhost/heimdall");
    const { getDbEnv } = await import("./env");
    expect(getDbEnv().DATABASE_URL).toBe("postgresql://localhost/heimdall");
    expect(getDbEnv().DATABASE_POOL_MAX).toBe(5);
    expect(getDbEnv().DATABASE_STATEMENT_TIMEOUT_MS).toBe(15_000);
    expect(getDbEnv().DATABASE_QUERY_TIMEOUT_MS).toBe(20_000);
  });

  it("getDbEnv validates bounded pool and timeout knobs", async () => {
    vi.stubEnv("DATABASE_URL", "postgresql://localhost/heimdall");
    vi.stubEnv("DATABASE_POOL_MAX", "500");
    const { getDbEnv } = await import("./env");
    expect(() => getDbEnv()).toThrow(/DATABASE_POOL_MAX/);
  });

  it("getDbEnv fails fast with the missing name", async () => {
    vi.stubEnv("DATABASE_URL", "");
    const { getDbEnv } = await import("./env");
    expect(() => getDbEnv()).toThrow(/DATABASE_URL/);
  });

  it("getR2Env lists every missing R2 variable", async () => {
    vi.stubEnv("R2_ACCOUNT_ID", "");
    vi.stubEnv("R2_ACCESS_KEY_ID", "");
    vi.stubEnv("R2_SECRET_ACCESS_KEY", "");
    vi.stubEnv("R2_BUCKET", "");
    const { getR2Env } = await import("./env");
    expect(() => getR2Env()).toThrow(
      /R2_ACCOUNT_ID.*R2_ACCESS_KEY_ID.*R2_SECRET_ACCESS_KEY.*R2_BUCKET/,
    );
  });
});
