/**
 * Public game discovery route (§17.7). The initial page is read directly from
 * the repository—never through self-HTTP—and metadata shares that request via
 * React cache. Unknown slugs are ordinary 404s.
 */

import { cache } from "react";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { GAME_SUBMISSIONS_PAGE_SIZE } from "@heimdall/shared";

import { GamePageClient } from "@/components/game/GamePageClient";
import { readGamePage } from "@/lib/repo/games";

export const runtime = "nodejs";

const getGamePage = cache((slug: string) =>
  readGamePage(slug, { limit: GAME_SUBMISSIONS_PAGE_SIZE }),
);

interface GamePageProps {
  params: Promise<{ slug: string }>;
}

export async function generateMetadata({ params }: GamePageProps): Promise<Metadata> {
  const { slug } = await params;
  const page = await getGamePage(slug);
  return {
    title: page ? `${page.game.name} performance submissions — Heimdall` : "Game — Heimdall",
    description: page
      ? `Explore individual public, validated ${page.game.name} performance submissions.`
      : undefined,
  };
}

export default async function GamePage({ params }: GamePageProps) {
  const { slug } = await params;
  const page = await getGamePage(slug);
  if (!page) notFound();
  return (
    <GamePageClient
      key={page.game.id}
      game={page.game}
      initialSubmissions={page.submissions}
    />
  );
}
