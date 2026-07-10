/**
 * CLI drain pass (§11.5): `pnpm --filter @heimdall/web jobs:drain`.
 * Same core as POST /api/internal/jobs/drain — one pass, then exit (the pg
 * pool has allowExitOnIdle, so the process ends cleanly on its own).
 */

import { existsSync } from "node:fs";
import path from "node:path";
import { runMaintenancePass } from "../src/lib/jobs/drain";

// Repo-root .env, if present (dev convenience; deployed workers use real env).
const envFile = path.resolve(import.meta.dirname, "..", "..", "..", ".env");
if (existsSync(envFile)) {
  process.loadEnvFile(envFile);
}

const result = await runMaintenancePass({ maxJobs: 50, budgetMs: 5 * 60_000 });

console.log(JSON.stringify(result, null, 2));
