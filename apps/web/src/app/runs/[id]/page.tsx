/**
 * Shareable run report route (§13). Server component: reads the run through
 * the SAME pre-auth visibility gate the API uses (readVisibleRun — missing,
 * private, flagged, and hidden are indistinguishable 404s), then hands the
 * row to the client component. No self-HTTP: the repo is right here.
 */

import { cache } from "react";
import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { readVisibleRun } from "@/lib/repo/runs";
import { RunPageClient } from "@/components/run/RunPageClient";

export const runtime = "nodejs";

/** Request-scoped dedupe so metadata + page share one DB read. */
const getVisibleRun = cache((id: string) => readVisibleRun(id));

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
  };
}

export default async function RunPage({ params }: RunPageProps) {
  const { id } = await params;
  const run = await getVisibleRun(id);
  if (!run) notFound();
  return <RunPageClient run={run} />;
}
