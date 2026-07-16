/** Operator-triggered, bounded legacy backfill. Full Parquet replay is never a cron surprise. */

import { existsSync } from "node:fs";
import path from "node:path";
import { drainReprocessJobs } from "../src/lib/jobs/drain";
import { enqueueFullReprocessJobs } from "../src/lib/repo/reprocess";

const envFile = path.resolve(import.meta.dirname, "..", "..", "..", ".env");
if (existsSync(envFile)) process.loadEnvFile(envFile);

function positiveIntegerFlag(name: string, fallback: number, maximum: number): number {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1) return fallback;
  const raw = process.argv[index + 1];
  if (raw === undefined || !/^\d+$/.test(raw)) {
    throw new Error(`--${name} requires a positive integer`);
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new Error(`--${name} must be between 1 and ${maximum}`);
  }
  return value;
}

const enqueueLimit = positiveIntegerFlag("enqueue-limit", 1_000, 50_000);
const maxJobs = positiveIntegerFlag("max-jobs", 25, 1_000);
const budgetMs = positiveIntegerFlag("budget-ms", 5 * 60_000, 30 * 60_000);

const enqueued = await enqueueFullReprocessJobs({ limit: enqueueLimit });
const drained = await drainReprocessJobs({ maxJobs, budgetMs });
console.log(JSON.stringify({ fullEnqueued: enqueued, ...drained }, null, 2));
