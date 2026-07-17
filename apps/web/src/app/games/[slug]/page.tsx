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
  gameSubmissionsQuerySchema,
  type GameSubmissionsQuery,
} from "@heimdall/shared";

import { GamePageClient } from "@/components/game/GamePageClient";
import { readGamePage } from "@/lib/repo/games";

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
  const page = await getGamePage(slug, query.sceneType, query.sortDirection);
  if (!page) notFound();
  return (
    <GamePageClient
      key={page.game.id}
      game={page.game}
      initialSubmissions={page.submissions}
      initialSceneFilter={query.sceneType ?? "all"}
      initialSortDirection={query.sortDirection ?? "desc"}
    />
  );
}
