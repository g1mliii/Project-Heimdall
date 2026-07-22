/**
 * Shareable run report route (§13). Server component: reads the run through
 * the SAME pre-auth visibility gate the API uses (readVisibleRun — missing,
 * private, flagged, and hidden are indistinguishable 404s), then hands the
 * row to the client component. No self-HTTP: the repo is right here.
 */

import { cache } from "react";
import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { RUN_VISIBILITY, runResponseSchema } from "@heimdall/shared";
import { readVisibleBenchmarkSet, readVisibleRun } from "@/lib/repo/runs";
import { getViewerIdentity } from "@/lib/api/auth";
import { RunPageClient } from "@/components/run/RunPageClient";

export const runtime = "nodejs";

/** Request-scoped dedupe so metadata + page share one viewer lookup + DB read. */
const getCurrentViewer = cache(() => getViewerIdentity());
const getVisibleRun = cache(async (id: string) => readVisibleRun(id, await getCurrentViewer()));

interface RunPageProps {
  params: Promise<{ id: string }>;
}

export async function generateMetadata({ params }: RunPageProps): Promise<Metadata> {
  const { id } = await params;
  const run = await getVisibleRun(id);
  return {
    title: run ? `${run.game} — Heimdall run report` : "Run report — Heimdall",
    description: run
      ? `${run.summary.avgFps.toFixed(1)} avg FPS · ${run.summary.onePercentLowFps.toFixed(1)} 1% low on ${run.hardware.gpu}`
      : undefined,
    ...(run?.visibility === RUN_VISIBILITY.unlisted
      ? { robots: { index: false, follow: false } }
      : {}),
  };
}

export default async function RunPage({ params }: RunPageProps) {
  const { id } = await params;
  const run = await getVisibleRun(id);
  if (!run) notFound();
  const benchmarkSet = await readVisibleBenchmarkSet(run, await getCurrentViewer());
  // §20.3: ownerId (a raw Clerk user id) never reaches the client component.
  // Same mechanism as GET /api/runs/:id — the wire schema is the one place
  // that decides which fields cross the boundary, so the two can't drift.
  const publicRun = runResponseSchema.parse(run);
  return <RunPageClient run={publicRun} benchmarkSet={benchmarkSet} />;
}
