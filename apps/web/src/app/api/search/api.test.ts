import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/repo/search", async (importActual) => ({
  // Keep the real normalizeSearchQuery (the route's gate) and mock only the DB read.
  ...(await importActual<typeof import("@/lib/repo/search")>()),
  searchCatalog: vi.fn(async () => ({
    games: [{ id: "1", slug: "cyberpunk-2077", name: "Cyberpunk 2077" }],
    hardware: [],
  })),
}));

vi.mock("@/lib/repo/rate-limit", () => ({
  consumeRateLimit: vi.fn(async () => ({ allowed: true, retryAfterSeconds: 0 })),
}));

import { consumeRateLimit } from "@/lib/repo/rate-limit";
import { searchCatalog } from "@/lib/repo/search";
import { GET } from "./route";

const searchMock = vi.mocked(searchCatalog);
const rateLimitMock = vi.mocked(consumeRateLimit);

describe("GET /api/search (§17.6)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    rateLimitMock.mockResolvedValue({ allowed: true, retryAfterSeconds: 0 });
  });

  it("returns catalog results with the public dictionary cache policy", async () => {
    const response = await GET(new Request("http://test/api/search?q=%20cyber%20"));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe(
      "public, max-age=0, s-maxage=60, stale-while-revalidate=300",
    );
    expect(await response.json()).toEqual({
      games: [{ id: "1", slug: "cyberpunk-2077", name: "Cyberpunk 2077" }],
      hardware: [],
    });
    expect(searchMock).toHaveBeenCalledWith("cyber");
    // §20.2f: anonymous callers key by ip, prefixed to disambiguate from user:{id}.
    expect(rateLimitMock).toHaveBeenCalledWith("search", "ip:unknown", 600, 3600);
  });

  it("treats a short query as an empty normal state without touching the limiter or repo", async () => {
    const response = await GET(new Request("http://test/api/search?q=rt"));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ games: [], hardware: [] });
    expect(searchMock).not.toHaveBeenCalled();
    expect(rateLimitMock).not.toHaveBeenCalled();
  });

  it("skips the limiter when a query only shrinks below the minimum after normalization", async () => {
    // "ab™" is 3 chars raw (passes the zod length) but normalizes to "ab" — the
    // route must gate on the normalized length, matching searchCatalog, so this
    // never spends a rate-limit token.
    const response = await GET(
      new Request(`http://test/api/search?q=${encodeURIComponent("ab™")}`),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ games: [], hardware: [] });
    expect(searchMock).not.toHaveBeenCalled();
    expect(rateLimitMock).not.toHaveBeenCalled();
  });

  it("rejects missing, overlong, duplicate, and unknown query parameters", async () => {
    for (const query of [
      "",
      `?q=${"x".repeat(65)}`,
      "?q=cyber&q=2077",
      "?q=cyber&limit=100",
    ]) {
      const response = await GET(new Request(`http://test/api/search${query}`));
      expect(response.status, query).toBe(400);
      expect(await response.json()).toEqual({
        error: {
          code: "invalid-request",
          message: "request query failed validation",
          details: expect.any(Array),
        },
      });
    }
    expect(searchMock).not.toHaveBeenCalled();
  });

  it("returns the shared 429 envelope when the catalog limit is exhausted", async () => {
    rateLimitMock.mockResolvedValue({ allowed: false, retryAfterSeconds: 42 });
    const response = await GET(new Request("http://test/api/search?q=cyber"));
    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("42");
    expect(searchMock).not.toHaveBeenCalled();
  });

  it("sanitizes repository failures", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    searchMock.mockRejectedValueOnce(new Error("postgres connection detail"));
    const response = await GET(new Request("http://test/api/search?q=cyber"));
    expect(response.status).toBe(500);
    expect(JSON.stringify(await response.json())).not.toContain("postgres connection detail");
    log.mockRestore();
  });
});
