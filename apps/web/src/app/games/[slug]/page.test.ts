import { beforeEach, describe, expect, it, vi } from "vitest";

const { notFound, readGamePage } = vi.hoisted(() => ({
  notFound: vi.fn(() => {
    throw new Error("NEXT_NOT_FOUND");
  }),
  readGamePage: vi.fn(),
}));

vi.mock("next/navigation", () => ({ notFound }));
vi.mock("@/lib/repo/games", () => ({ readGamePage }));

import GamePage, { generateMetadata } from "./page";

const result = {
  game: { id: "17", slug: "cyberpunk-2077", name: "Cyberpunk 2077" },
  submissions: { rows: [], nextCursor: null },
};

describe("game page route", () => {
  beforeEach(() => {
    readGamePage.mockReset();
    notFound.mockClear();
  });

  it("builds metadata without inventing a pooled count", async () => {
    readGamePage.mockResolvedValue(result);
    const metadata = await generateMetadata({
      params: Promise.resolve({ slug: "metadata-cyberpunk" }),
    });

    expect(metadata).toMatchObject({
      title: "Cyberpunk 2077 performance submissions — Heimdall",
    });
    expect(JSON.stringify(metadata)).not.toMatch(/\d+\s+(?:public\s+)?runs/i);
  });

  it("hands the server-read first page to the client shell", async () => {
    readGamePage.mockResolvedValue(result);
    const page = await GamePage({ params: Promise.resolve({ slug: "page-cyberpunk" }) });

    expect(readGamePage).toHaveBeenCalledWith("page-cyberpunk", { limit: 25 });
    expect(page.props).toEqual({
      game: result.game,
      initialSubmissions: result.submissions,
      initialSceneFilter: "all",
      initialSortDirection: "desc",
    });
  });

  it("restores a valid shared submissions filter and recency direction", async () => {
    readGamePage.mockResolvedValue(result);
    const page = await GamePage({
      params: Promise.resolve({ slug: "filtered-cyberpunk" }),
      searchParams: Promise.resolve({ sceneType: "gameplay", sortDirection: "asc" }),
    });

    expect(readGamePage).toHaveBeenCalledWith("filtered-cyberpunk", {
      limit: 25,
      sceneType: "gameplay",
      sortDirection: "asc",
    });
    expect(page.props).toMatchObject({
      initialSceneFilter: "gameplay",
      initialSortDirection: "asc",
    });
  });

  it("returns a not-found response for an unknown slug", async () => {
    readGamePage.mockResolvedValue(null);
    await expect(
      GamePage({ params: Promise.resolve({ slug: "unknown-game" }) }),
    ).rejects.toThrow("NEXT_NOT_FOUND");
    expect(notFound).toHaveBeenCalledOnce();
  });
});
