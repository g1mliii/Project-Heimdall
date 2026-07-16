import { beforeEach, describe, expect, it, vi } from "vitest";

const { readGamePage } = vi.hoisted(() => ({ readGamePage: vi.fn() }));

vi.mock("@/lib/repo/games", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/repo/games")>();
  return { ...actual, readGamePage };
});

import { InvalidGameSubmissionsCursorError } from "@/lib/repo/games";
import { GET } from "./route";

const context = (slug = "cyberpunk-2077") => ({ params: Promise.resolve({ slug }) });
const result = {
  game: { id: "17", slug: "cyberpunk-2077", name: "Cyberpunk 2077" },
  submissions: { rows: [], nextCursor: "next_page" },
};

describe("GET /api/games/:slug/runs (§17.7)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    readGamePage.mockResolvedValue(result);
  });

  it("returns the requested page with a private no-store policy", async () => {
    const response = await GET(
      new Request("http://test/api/games/cyberpunk-2077/runs?limit=12&sceneType=gameplay&cursor=abc"),
      context(),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(await response.json()).toEqual(result.submissions);
    expect(readGamePage).toHaveBeenCalledWith("cyberpunk-2077", {
      limit: 12,
      sceneType: "gameplay",
      cursor: "abc",
    });
  });

  it("applies the default page size when no query is supplied", async () => {
    await GET(new Request("http://test/api/games/cyberpunk-2077/runs"), context());
    expect(readGamePage).toHaveBeenCalledWith("cyberpunk-2077", { limit: 25 });
  });

  it("rejects duplicate, unknown, malformed, and oversized query values", async () => {
    for (const query of [
      "?limit=2&limit=3",
      "?limit=51",
      "?sceneType=cutscene",
      "?cursor=not+padded",
      "?sort=avg",
    ]) {
      const response = await GET(
        new Request(`http://test/api/games/cyberpunk-2077/runs${query}`),
        context(),
      );
      expect(response.status, query).toBe(400);
      expect(response.headers.get("cache-control"), query).toBe("private, no-store");
      expect(await response.json()).toEqual({
        error: {
          code: "invalid-request",
          message: "request query failed validation",
          details: expect.any(Array),
        },
      });
    }
    expect(readGamePage).not.toHaveBeenCalled();
  });

  it("returns 400 for a well-shaped but semantically invalid cursor", async () => {
    readGamePage.mockRejectedValueOnce(new InvalidGameSubmissionsCursorError());
    const response = await GET(
      new Request("http://test/api/games/cyberpunk-2077/runs?cursor=bm90LWRhdGV8cnVu"),
      context(),
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: { code: "invalid-request", message: "cursor is invalid" },
    });
  });

  it("returns a private 404 for an unknown game", async () => {
    readGamePage.mockResolvedValueOnce(null);
    const response = await GET(
      new Request("http://test/api/games/unknown/runs"),
      context("unknown"),
    );
    expect(response.status).toBe(404);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
  });

  it("sanitizes repository failures", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    readGamePage.mockRejectedValueOnce(new Error("postgres connection detail"));
    const response = await GET(
      new Request("http://test/api/games/cyberpunk-2077/runs"),
      context(),
    );
    expect(response.status).toBe(500);
    expect(JSON.stringify(await response.json())).not.toContain("postgres connection detail");
    log.mockRestore();
  });
});
