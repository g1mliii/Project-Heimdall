"use client";

/**
 * Client-side interactions for the game-page design-kit port. The submissions
 * controls and the Phase 7.5 exact-cohort distribution controls stay separate:
 * each owns its own query/load state and neither silently scopes the other.
 */

import * as React from "react";
import {
  GAME_SUBMISSIONS_PAGE_SIZE,
  type GameDistributionResponse,
  type GameSubmissionsPage,
  type GameSubmissionsQuery,
  type SearchGameResult,
} from "@heimdall/shared";

import { loadGameRuns, type ApiResult } from "@/lib/api/client";
import { DistributionSection, type GameDistributionLoader } from "./DistributionSection";
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
  sortDirection: NonNullable<GameSubmissionsQuery["sortDirection"]>;
}

interface FailedLoad extends PageRequest {
  message: string;
}

export function GamePageClient({
  game,
  initialSubmissions,
  initialDistribution,
  viewerRunId,
  initialSceneFilter = "all",
  initialSortDirection = "desc",
  loadRuns = defaultGameRunsLoader,
  loadDistribution,
}: {
  game: SearchGameResult;
  initialSubmissions: GameSubmissionsPage;
  /**
   * Server-rendered distribution; null when the read failed. The section is
   * still rendered — it re-fetches client-side and shows a retryable error —
   * so a transient read failure never silently deletes a page region.
   */
  initialDistribution: GameDistributionResponse | null;
  /** The viewer's own run id, for a "You: Nth percentile" marker (from `?run=`). */
  viewerRunId?: string;
  initialSceneFilter?: SceneFilter;
  initialSortDirection?: NonNullable<GameSubmissionsQuery["sortDirection"]>;
  loadRuns?: GameRunsLoader;
  /** Testing seam, mirroring `loadRuns`; the section supplies its own default. */
  loadDistribution?: GameDistributionLoader;
}) {
  const [rows, setRows] = React.useState(initialSubmissions.rows);
  const [nextCursor, setNextCursor] = React.useState(initialSubmissions.nextCursor);
  const [sceneFilter, setSceneFilter] = React.useState<SceneFilter>(initialSceneFilter);
  const [sortDirection, setSortDirection] = React.useState(initialSortDirection);
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
    const { sceneFilter: requestedFilter, sortDirection: requestedSortDirection, cursor, append } = request;
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
      ...(requestedSortDirection === "desc" ? {} : { sortDirection: requestedSortDirection }),
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
    updateUrl(value, sortDirection);
    void requestPage({ sceneFilter: value, sortDirection, append: false });
  }

  function changeSortDirection(value: NonNullable<GameSubmissionsQuery["sortDirection"]>) {
    if (value === sortDirection) return;
    setSortDirection(value);
    updateUrl(sceneFilter, value);
    void requestPage({ sceneFilter, sortDirection: value, append: false });
  }

  function updateUrl(
    nextSceneFilter: SceneFilter,
    nextSortDirection: NonNullable<GameSubmissionsQuery["sortDirection"]>,
  ) {
    const url = new URL(window.location.href);
    if (nextSceneFilter === "all") {
      url.searchParams.delete("sceneType");
    } else {
      url.searchParams.set("sceneType", nextSceneFilter);
    }
    if (nextSortDirection === "desc") {
      url.searchParams.delete("sortDirection");
    } else {
      url.searchParams.set("sortDirection", nextSortDirection);
    }
    window.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
  }

  return (
    <main id="main-content" tabIndex={-1} className={styles.page}>
      <GameHeader game={game} />
      <DistributionSection
        game={game}
        initial={initialDistribution}
        {...(viewerRunId ? { viewerRunId } : {})}
        {...(loadDistribution ? { loadDistribution } : {})}
      />

      <SubmissionsTable
        rows={rows}
        sceneFilter={sceneFilter}
        onSceneFilterChange={changeSceneFilter}
        sortDirection={sortDirection}
        onSortDirectionChange={changeSortDirection}
        loading={loading}
        error={failedLoad?.message ?? null}
        canLoadMore={nextCursor !== null}
        onLoadMore={() => {
          if (nextCursor) {
            void requestPage({ sceneFilter, sortDirection, cursor: nextCursor, append: true });
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
