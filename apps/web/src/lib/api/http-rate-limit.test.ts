import { describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ proxy: "none", consume: vi.fn() }));

vi.mock("../env", () => ({
  getAuthEnv: vi.fn(() => ({ RATE_LIMIT_AUTHED_MULTIPLIER: 3 })),
  getIngestEnv: vi.fn(() => ({ RATE_LIMIT_TRUSTED_PROXY: state.proxy })),
}));
vi.mock("../repo/rate-limit", () => ({ consumeRateLimit: state.consume }));

import { clientIp, requireRateLimit } from "./http";

describe("clientIp trusted proxy boundary", () => {
  it("does not accept a forgeable forwarded header until a proxy is explicitly configured", () => {
    state.proxy = "none";
    const request = new Request("http://test/api/runs", {
      headers: { "cf-connecting-ip": "203.0.113.10", "x-forwarded-for": "198.51.100.2" },
    });

    expect(clientIp(request)).toBe("unknown");
  });

  it("uses only a valid IP from the selected trusted proxy", () => {
    state.proxy = "cloudflare";
    expect(clientIp(new Request("http://test", { headers: { "cf-connecting-ip": "203.0.113.10" } }))).toBe(
      "203.0.113.10",
    );
    expect(clientIp(new Request("http://test", { headers: { "cf-connecting-ip": "not-an-ip" } }))).toBe(
      "unknown",
    );
  });
});

describe("requireRateLimit", () => {
  it("fails closed when the limiter store is unavailable", async () => {
    state.consume.mockRejectedValueOnce(new Error("database unavailable"));

    const response = await requireRateLimit("create-runs", new Request("http://test/api/runs"), 30);

    expect(response?.status).toBe(503);
    await expect(response?.json()).resolves.toEqual({
      error: { code: "rate-limit-unavailable", message: "rate limit is temporarily unavailable" },
    });
  });
});
