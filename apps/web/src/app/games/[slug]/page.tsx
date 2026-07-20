/**
 * Public game discovery route (§17.7). The initial page is read directly from
 * the repository—never through self-HTTP—and metadata shares that request via
 * React cache. Unknown slugs are ordinary 404s.
 */

import { cache } from "react";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import {
  GAME_SUBMISSIONS_PAGE_SIZE,
  gameDistributionQuerySchema,
  gameSubmissionsQuerySchema,
  type GameDistributionQuery,
  type GameSubmissionsQuery,
} from "@heimdall/shared";

import { GamePageClient } from "@/components/game/GamePageClient";
import { readGamePage } from "@/lib/repo/games";
import { readGameDistribution } from "@/lib/repo/distribution";

export const runtime = "nodejs";

type GamePageSearchParams = Record<string, string | string[] | undefined>;

function singleSearchParam(value: string | string[] | undefined): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function initialSubmissionsQuery(searchParams: GamePageSearchParams): GameSubmissionsQuery {
  const parsed = gameSubmissionsQuerySchema.safeParse({
    limit: GAME_SUBMISSIONS_PAGE_SIZE,
    ...(singleSearchParam(searchParams.sceneType)
      ? { sceneType: singleSearchParam(searchParams.sceneType) }
      : {}),
    ...(singleSearchParam(searchParams.sortDirection)
      ? { sortDirection: singleSearchParam(searchParams.sortDirection) }
      : {}),
  });
  return parsed.success ? parsed.data : { limit: GAME_SUBMISSIONS_PAGE_SIZE };
}

/**
 * The server-rendered distribution query, through the SAME schema the route
 * handler uses. Both entry points to `readGameDistribution` must enforce one
 * input contract — otherwise `?run=` is length-capped over HTTP and unbounded on
 * SSR. An unparseable `?run=` degrades to no marker, never a 404.
 */
function initialDistributionQuery(viewerRunId: string | undefined): GameDistributionQuery {
  const parsed = gameDistributionQuerySchema.safeParse({
    // The section defaults to its "all" workload, so no scene filter here.
    metric: "avg-fps",
    ...(viewerRunId ? { viewerRunId } : {}),
  });
  return parsed.success ? parsed.data : { metric: "avg-fps" };
}

const getGamePage = cache(
  (slug: string, sceneType?: GameSubmissionsQuery["sceneType"], sortDirection?: GameSubmissionsQuery["sortDirection"]) =>
    readGamePage(slug, {
      limit: GAME_SUBMISSIONS_PAGE_SIZE,
      ...(sceneType ? { sceneType } : {}),
      ...(sortDirection ? { sortDirection } : {}),
    }),
);

interface GamePageProps {
  params: Promise<{ slug: string }>;
  searchParams?: Promise<GamePageSearchParams>;
}

export async function generateMetadata({ params, searchParams }: GamePageProps): Promise<Metadata> {
  const [{ slug }, rawSearchParams = {}] = await Promise.all([params, searchParams]);
  const query = initialSubmissionsQuery(rawSearchParams);
  const page = await getGamePage(slug, query.sceneType, query.sortDirection);
  return {
    title: page ? `${page.game.name} performance submissions — Heimdall` : "Game — Heimdall",
    description: page
      ? `Explore individual public, validated ${page.game.name} performance submissions.`
      : undefined,
  };
}

export default async function GamePage({ params, searchParams }: GamePageProps) {
  const [{ slug }, rawSearchParams = {}] = await Promise.all([params, searchParams]);
  const query = initialSubmissionsQuery(rawSearchParams);
  const distributionQuery = initialDistributionQuery(singleSearchParam(rawSearchParams.run));
  const viewerRunId = distributionQuery.viewerRunId;
  // A bad viewer id just yields no marker, so a failed read must not 404 the
  // page — the client re-fetches the section instead (see GamePageClient).
  const [page, distribution] = await Promise.all([
    getGamePage(slug, query.sceneType, query.sortDirection),
    readGameDistribution(slug, distributionQuery).catch((error) => {
      console.error("game distribution read failed", error);
      return null;
    }),
  ]);
  if (!page) notFound();
  return (
    <GamePageClient
      key={page.game.id}
      game={page.game}
      initialSubmissions={page.submissions}
      initialDistribution={distribution}
      {...(viewerRunId ? { viewerRunId } : {})}
      initialSceneFilter={query.sceneType ?? "all"}
      initialSortDirection={query.sortDirection ?? "desc"}
    />
  );
}
