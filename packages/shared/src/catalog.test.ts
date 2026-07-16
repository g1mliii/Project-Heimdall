import { describe, expect, it } from "vitest";

import {
  GAME_SUBMISSIONS_MAX_PAGE_SIZE,
  GAME_SUBMISSIONS_PAGE_SIZE,
  SEARCH_MIN_QUERY_LENGTH,
  SEARCH_RESULT_LIMIT,
  SEARCH_SIMILARITY_THRESHOLD,
} from "./constants";
import {
  gameSubmissionsPageSchema,
  gameSubmissionsQuerySchema,
  searchQuerySchema,
  searchResponseSchema,
} from "./schemas";
import type { GameSubmissionsPage, SearchResponse } from "./types";

describe("catalog search contracts (§17.6)", () => {
  it("pins the bounded public-search policy", () => {
    expect(SEARCH_MIN_QUERY_LENGTH).toBe(3);
    expect(SEARCH_RESULT_LIMIT).toEqual({ games: 8, hardware: 5 });
    expect(SEARCH_SIMILARITY_THRESHOLD).toBe(0.3);
  });

  it("normalizes queries while treating short input as a valid state", () => {
    expect(searchQuerySchema.parse({ q: "  cy  " })).toEqual({ q: "cy" });
    expect(searchQuerySchema.safeParse({ q: "x".repeat(65) }).success).toBe(false);
    expect(searchQuerySchema.safeParse({}).success).toBe(false);
  });

  it("caps each result kind independently", () => {
    const result: SearchResponse = {
      games: [{ id: "1", slug: "cyberpunk-2077", name: "Cyberpunk 2077" }],
      hardware: [
        { id: "2", kind: "gpu", vendor: "nvidia", canonicalName: "RTX 4070" },
      ],
    };
    const parsed = searchResponseSchema.parse(result);
    const backToDomain: SearchResponse = parsed;
    expect(backToDomain).toEqual(result);
    expect(
      searchResponseSchema.safeParse({
        games: Array.from({ length: SEARCH_RESULT_LIMIT.games + 1 }, (_, id) => ({
          id: String(id),
          slug: `game-${id}`,
          name: `Game ${id}`,
        })),
        hardware: [],
      }).success,
    ).toBe(false);
  });
});

describe("game submission contracts (§17.7)", () => {
  const row = {
    id: "run_public_0001",
    createdAt: "2026-07-16T12:00:00.000Z",
    gpu: "RTX 4070",
    cpu: "Ryzen 7 7800X3D",
    sceneType: "benchmark-scene" as const,
    avgFps: 145,
    onePercentLowFps: 98,
    pointOnePercentLowFps: 71,
    submittedBy: null,
    methodology: {
      profileComplete: true,
      resolution: "2560x1440",
      graphicsApi: "dx12",
      upscaler: "dlss" as const,
      rayTracing: "on" as const,
      frameGeneration: "none" as const,
    },
    isWarmup: false,
    benchmarkSetId: null,
    gpuDriver: "32.0.15.7688",
    requiredDriver: "32.0.15.6000",
    latestDriver: "32.0.15.8000",
  };

  it("defaults and bounds keyset pages", () => {
    expect(gameSubmissionsQuerySchema.parse({})).toEqual({
      limit: GAME_SUBMISSIONS_PAGE_SIZE,
    });
    expect(gameSubmissionsQuerySchema.parse({ limit: "50", sceneType: "gameplay" })).toEqual({
      limit: GAME_SUBMISSIONS_MAX_PAGE_SIZE,
      sceneType: "gameplay",
    });
    expect(gameSubmissionsQuerySchema.safeParse({ limit: 51 }).success).toBe(false);
    expect(gameSubmissionsQuerySchema.safeParse({ cursor: "not+base64" }).success).toBe(false);
    expect(gameSubmissionsQuerySchema.safeParse({ sceneType: "all" }).success).toBe(false);
  });

  it("round-trips a page without manufacturing a total", () => {
    const page: GameSubmissionsPage = { rows: [row], nextCursor: "Y3Vyc29y" };
    const parsed = gameSubmissionsPageSchema.parse(page);
    const backToDomain: GameSubmissionsPage = parsed;
    expect(backToDomain).toEqual(page);
    expect(parsed).not.toHaveProperty("total");
  });
});
