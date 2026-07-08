/**
 * CLI drain pass (§11.5): `pnpm --filter @heimdall/web jobs:drain`.
 * Same core as POST /api/internal/jobs/drain — one pass, then exit (the pg
 * pool has allowExitOnIdle, so the process ends cleanly on its own).
 */

import { existsSync } from "node:fs";
import path from "node:path";
import { cleanupStalePending, drainJobs } from "../src/lib/jobs/drain";
import { pruneRateLimits } from "../src/lib/repo/rate-limit";

// Repo-root .env, if present (dev convenience; deployed workers use real env).
const envFile = path.resolve(import.meta.dirname, "..", "..", "..", ".env");
if (existsSync(envFile)) {
  process.loadEnvFile(envFile);
}

const drained = await drainJobs({ maxJobs: 50, budgetMs: 5 * 60_000 });
const cleanedStalePending = await cleanupStalePending();
const prunedRateLimitWindows = await pruneRateLimits();

console.log(
  JSON.stringify({ ...drained, cleanedStalePending, prunedRateLimitWindows }, null, 2),
);
