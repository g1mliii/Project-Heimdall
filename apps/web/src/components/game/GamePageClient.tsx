"use client";

/**
 * Phase 7.0 port of design/ui_kits/web/GamePage.jsx.
 *
 * Deliberate reference deviations: pooled-run counts, percentile/rank, the
 * BellCurve branch, GPU/resolution/API/verified cohort filters, and the kit's
 * duplicate cold-start rows are absent. Workload controls scope only the
 * individual submissions table, while the distribution region remains a
 * structurally curve-free placeholder.
 */

import * as React from "react";
import {
  GAME_SUBMISSIONS_PAGE_SIZE,
  type GameSubmissionsPage,
  type GameSubmissionsQuery,
  type SearchGameResult,
} from "@heimdall/shared";

import { loadGameRuns, type ApiResult } from "@/lib/api/client";
import { DistributionEmptyState } from "./DistributionEmptyState";
import { GameHeader } from "./GameHeader";
import { SubmissionsTable, type SceneFilter } from "./SubmissionsTable";
import styles from "./GamePageClient.module.css";

export type GameRunsLoader = (
  slug: string,
  query: GameSubmissionsQuery,
  signal?: AbortSignal,
) => Promise<ApiResult<GameSubmissionsPage>>;

const defaultGameRunsLoader: GameRunsLoader = (slug, query, signal) =>
  loadGameRuns(slug, query, undefined, signal);

interface PageRequest {
  cursor?: string;
  append: boolean;
  sceneFilter: SceneFilter;
}

interface FailedLoad extends PageRequest {
  message: string;
}

export function GamePageClient({
  game,
  initialSubmissions,
  loadRuns = defaultGameRunsLoader,
}: {
  game: SearchGameResult;
  initialSubmissions: GameSubmissionsPage;
  loadRuns?: GameRunsLoader;
}) {
  const [rows, setRows] = React.useState(initialSubmissions.rows);
  const [nextCursor, setNextCursor] = React.useState(initialSubmissions.nextCursor);
  const [sceneFilter, setSceneFilter] = React.useState<SceneFilter>("all");
  const [loading, setLoading] = React.useState(false);
  const [failedLoad, setFailedLoad] = React.useState<FailedLoad | null>(null);
  const requestId = React.useRef(0);
  const controller = React.useRef<AbortController | null>(null);

  React.useEffect(
    () => () => {
      requestId.current += 1;
      controller.current?.abort();
    },
    [],
  );

  async function requestPage(request: PageRequest) {
    const { sceneFilter: requestedFilter, cursor, append } = request;
    controller.current?.abort();
    const nextController = new AbortController();
    controller.current = nextController;
    const currentRequest = ++requestId.current;
    setLoading(true);
    setFailedLoad(null);
    if (!append) {
      setRows([]);
      setNextCursor(null);
    }

    const query: GameSubmissionsQuery = {
      limit: GAME_SUBMISSIONS_PAGE_SIZE,
      ...(cursor ? { cursor } : {}),
      ...(requestedFilter === "all" ? {} : { sceneType: requestedFilter }),
    };

    try {
      const result = await loadRuns(game.slug, query, nextController.signal);
      if (currentRequest !== requestId.current) return;
      if (result.ok) {
        setRows((current) => (append ? [...current, ...result.data.rows] : result.data.rows));
        setNextCursor(result.data.nextCursor);
      } else if (result.code !== "aborted") {
        setFailedLoad({ ...request, message: result.message });
      }
    } catch (cause) {
      if (currentRequest !== requestId.current) return;
      setFailedLoad({
        ...request,
        message: cause instanceof Error ? cause.message : String(cause),
      });
    } finally {
      if (currentRequest === requestId.current) setLoading(false);
    }
  }

  function changeSceneFilter(value: SceneFilter) {
    if (value === sceneFilter) return;
    setSceneFilter(value);
    void requestPage({ sceneFilter: value, append: false });
  }

  return (
    <main id="main-content" tabIndex={-1} className={styles.page}>
      <GameHeader game={game} />
      <DistributionEmptyState />
      <SubmissionsTable
        rows={rows}
        sceneFilter={sceneFilter}
        onSceneFilterChange={changeSceneFilter}
        loading={loading}
        error={failedLoad?.message ?? null}
        canLoadMore={nextCursor !== null}
        onLoadMore={() => {
          if (nextCursor) {
            void requestPage({ sceneFilter, cursor: nextCursor, append: true });
          }
        }}
        onRetry={() => {
          if (failedLoad) {
            void requestPage(failedLoad);
          }
        }}
      />
    </main>
  );
}
