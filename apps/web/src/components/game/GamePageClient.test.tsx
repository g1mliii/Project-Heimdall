// @vitest-environment jsdom

import * as React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom/vitest";
import type { GameSubmissionRow, SearchGameResult } from "@heimdall/shared";

import { DistributionEmptyState } from "./DistributionEmptyState";
import { GamePageClient, type GameRunsLoader } from "./GamePageClient";

const game: SearchGameResult = { id: "17", slug: "cyberpunk-2077", name: "Cyberpunk 2077" };

function submission(
  id: string,
  overrides: Partial<GameSubmissionRow> = {},
): GameSubmissionRow {
  return {
    id,
    createdAt: "2026-07-15T12:00:00.000Z",
    gpu: "NVIDIA GeForce RTX 4070",
    cpu: "AMD Ryzen 7 7800X3D",
    sceneType: "benchmark-scene",
    avgFps: 145.2,
    onePercentLowFps: 98.1,
    pointOnePercentLowFps: 71.4,
    submittedBy: null,
    methodology: {
      profileComplete: true,
      resolution: "2560x1440",
      graphicsApi: "dx12",
      upscaler: "dlss",
      rayTracing: "on",
      frameGeneration: "dlss3",
    },
    isWarmup: false,
    benchmarkSetId: null,
    gpuDriver: "566.36",
    requiredDriver: "600.00",
    latestDriver: "610.00",
    ...overrides,
  };
}

afterEach(cleanup);

describe("GamePageClient (§17.7)", () => {
  it("renders mixed individual-run facts without pooled statistics or verified shields", () => {
    const rows = [
      submission("current"),
      submission("legacy", {
        sceneType: null,
        methodology: {
          profileComplete: false,
          resolution: null,
          graphicsApi: null,
          upscaler: null,
          rayTracing: null,
          frameGeneration: "none",
        },
        gpuDriver: null,
        requiredDriver: null,
        latestDriver: null,
      }),
      submission("warmup", { sceneType: "gameplay", isWarmup: true }),
      submission("set-member", {
        sceneType: "freeform",
        benchmarkSetId: "017f22e2-79b0-4f15-a3cb-a3e24f51f345",
      }),
    ];
    const { container } = render(
      <GamePageClient game={game} initialSubmissions={{ rows, nextCursor: null }} />,
    );

    expect(screen.getByRole("heading", { level: 1, name: game.name })).toBeInTheDocument();
    expect(screen.getByText("4 shown")).toBeInTheDocument();
    expect(screen.getByText("Profile incomplete")).toBeInTheDocument();
    expect(screen.getByText("Warm-up")).toBeInTheDocument();
    expect(screen.getByText("Set member")).toBeInTheDocument();
    expect(screen.getAllByText("Freeform")).toHaveLength(2);
    expect(screen.getAllByText("Anonymous")).toHaveLength(4);
    expect(screen.getAllByText("Driver below game minimum")).not.toHaveLength(0);
    expect(screen.getAllByText("Driver outdated")).not.toHaveLength(0);
    expect(screen.getAllByRole("link", { name: "NVIDIA GeForce RTX 4070" })[0]).toHaveAttribute(
      "href",
      "/runs/current",
    );
    expect(container.querySelector("[data-chart], canvas")).toBeNull();
    expect(container.querySelector("[data-icon='shield-check']")).toBeNull();
    expect(screen.queryByText(/\d+\s+(?:public\s+)?runs/i)).not.toBeInTheDocument();
  });

  it("replaces the table with the selected workload page", async () => {
    const user = userEvent.setup();
    const gameplay = submission("gameplay-only", {
      gpu: "AMD Radeon RX 7800 XT",
      sceneType: "gameplay",
    });
    const loadRuns = vi.fn<GameRunsLoader>().mockResolvedValue({
      ok: true,
      data: { rows: [gameplay], nextCursor: null },
    });
    render(
      <GamePageClient
        game={game}
        initialSubmissions={{ rows: [submission("initial")], nextCursor: null }}
        loadRuns={loadRuns}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Gameplay" }));
    expect(await screen.findByRole("link", { name: "AMD Radeon RX 7800 XT" })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "NVIDIA GeForce RTX 4070" })).not.toBeInTheDocument();
    expect(loadRuns).toHaveBeenCalledWith(
      game.slug,
      { limit: 25, sceneType: "gameplay" },
      expect.any(AbortSignal),
    );
  });

  it("appends the next keyset page", async () => {
    const user = userEvent.setup();
    const loadRuns = vi.fn<GameRunsLoader>().mockResolvedValue({
      ok: true,
      data: {
        rows: [submission("second", { gpu: "NVIDIA GeForce RTX 4090" })],
        nextCursor: null,
      },
    });
    render(
      <GamePageClient
        game={game}
        initialSubmissions={{ rows: [submission("first")], nextCursor: "cursor_one" }}
        loadRuns={loadRuns}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Load more" }));
    expect(await screen.findByRole("link", { name: "NVIDIA GeForce RTX 4090" })).toBeInTheDocument();
    expect(screen.getByText("2 shown")).toBeInTheDocument();
    expect(loadRuns).toHaveBeenCalledWith(
      game.slug,
      { limit: 25, cursor: "cursor_one" },
      expect.any(AbortSignal),
    );
  });

  it("shows a sanitized loader failure and retries the failed request", async () => {
    const user = userEvent.setup();
    const loadRuns = vi
      .fn<GameRunsLoader>()
      .mockResolvedValueOnce({ ok: false, code: "network", message: "Connection lost" })
      .mockResolvedValueOnce({
        ok: true,
        data: { rows: [submission("recovered")], nextCursor: null },
      });
    render(
      <GamePageClient
        game={game}
        initialSubmissions={{ rows: [submission("initial")], nextCursor: null }}
        loadRuns={loadRuns}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Freeform" }));
    expect(await screen.findByText("Could not load submissions")).toBeInTheDocument();
    expect(screen.getByText("Connection lost")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByRole("link", { name: "NVIDIA GeForce RTX 4070" })).toHaveAttribute(
      "href",
      "/runs/recovered",
    );
    expect(loadRuns).toHaveBeenCalledTimes(2);
  });

  it("aborts an in-flight page request when unmounted", async () => {
    const user = userEvent.setup();
    let signal: AbortSignal | undefined;
    const loadRuns: GameRunsLoader = (_slug, _query, nextSignal) => {
      signal = nextSignal;
      return new Promise(() => undefined);
    };
    const { unmount } = render(
      <GamePageClient
        game={game}
        initialSubmissions={{ rows: [submission("initial")], nextCursor: null }}
        loadRuns={loadRuns}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Gameplay" }));
    expect(signal?.aborted).toBe(false);
    unmount();
    expect(signal?.aborted).toBe(true);
  });
});

describe("DistributionEmptyState", () => {
  it("is always a curve-free comparable-data explanation", () => {
    const { container } = render(<DistributionEmptyState />);
    expect(screen.getByText("Insufficient comparable data")).toBeInTheDocument();
    expect(container.querySelector("svg[data-chart], canvas")).toBeNull();
  });
});
