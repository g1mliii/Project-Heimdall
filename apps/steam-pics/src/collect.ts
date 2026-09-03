import {
  readCursor,
  readTrackedApps,
  writeBuilds,
  writeCursor,
  writeDepots,
  writeManifests,
  type SqlExecutor,
  type WriteCounts,
} from "./db.js";
import { parseProductInfo, type AppBuild, type AppDepot, type DepotManifest } from "./parse.js";
import type { SteamClient } from "./steam.js";

/**
 * PICS accepts many appids per call, but a single enormous request is a single
 * enormous failure. Chunking bounds the blast radius and the response size.
 */
export const PRODUCT_INFO_BATCH = 50;

export interface CollectLogger {
  info(message: string, data?: Record<string, unknown>): void;
  warn(message: string, data?: Record<string, unknown>): void;
}

export interface CollectOptions {
  execute: SqlExecutor;
  client: SteamClient;
  logger?: CollectLogger;
  now?: Date;
  batchSize?: number;
}

export interface CollectReport {
  appsQueried: number;
  changedAppsSeen: number;
  builds: WriteCounts;
  depots: WriteCounts;
  manifests: WriteCounts;
  cursor: number | null;
  batchesFailed: number;
}

const defaultLogger: CollectLogger = {
  info: (message, data) => console.info(message, data ?? {}),
  warn: (message, data) => console.warn(message, data ?? {}),
};

function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    out.push(items.slice(index, index + size));
  }
  return out;
}

/**
 * One collection cycle: connect, refresh every tracked app, record what moved.
 *
 * THE CHANGELIST IS NOT THE SOURCE OF TRUTH, deliberately. Measured behaviour:
 * asking for changes since a changenumber a few thousand behind returns an
 * EMPTY app list — no error, no `forceFullUpdate` flag — so a collector that
 * only followed the changelist would silently stop noticing patches after any
 * gap (a failed run, a paused schedule, a weekend). Instead every run refreshes
 * the full tracked set, which is bounded and cheap, and the changelist is used
 * only to record provenance and to prioritise. Missing a changelist entry
 * therefore costs nothing: the build still lands with its own `timeupdated`.
 */
export async function collectOnce({
  execute,
  client,
  logger = defaultLogger,
  now = new Date(),
  batchSize = PRODUCT_INFO_BATCH,
}: CollectOptions): Promise<CollectReport> {
  const seenAt = now.toISOString();
  const tracked = await readTrackedApps(execute);

  let changedAppsSeen = 0;
  let cursor: number | null = null;
  try {
    const since = (await readCursor(execute)) ?? 0;
    const changes = await client.getProductChanges(since);
    cursor = changes.currentChangeNumber || null;
    const trackedSet = new Set(tracked);
    changedAppsSeen = changes.appIds.filter((appid) => trackedSet.has(appid)).length;
  } catch (error) {
    // Provenance only. Losing it costs the changenumber column, never a build.
    logger.warn("pics changelist unavailable", { error: summarise(error) });
  }

  const builds: AppBuild[] = [];
  const depots: AppDepot[] = [];
  const manifests: DepotManifest[] = [];
  let batchesFailed = 0;

  for (const batch of chunk(tracked, batchSize)) {
    let info;
    try {
      info = await client.getProductInfo(batch);
    } catch (error) {
      // One bad batch must not discard the batches that already succeeded.
      batchesFailed++;
      logger.warn("pics product info batch failed", {
        apps: batch.length,
        error: summarise(error),
      });
      continue;
    }
    for (const [appid, entry] of info) {
      const parsed = parseProductInfo(appid, entry.changenumber, entry.appinfo);
      builds.push(...parsed.builds);
      depots.push(...parsed.depots);
      manifests.push(...parsed.manifests);
    }
  }

  const buildCounts = await writeBuilds(execute, builds, seenAt);
  const depotCounts = await writeDepots(execute, depots, seenAt);
  const manifestCounts = await writeManifests(execute, manifests, seenAt);

  // Advance the cursor only after the writes land, so a crash mid-run re-reads
  // the same window instead of skipping it.
  if (cursor !== null) {
    try {
      await writeCursor(execute, cursor);
    } catch (error) {
      logger.warn("pics cursor write failed", { error: summarise(error) });
    }
  }

  return {
    appsQueried: tracked.length,
    changedAppsSeen,
    builds: buildCounts,
    depots: depotCounts,
    manifests: manifestCounts,
    cursor,
    batchesFailed,
  };
}

/** Never let a connection string reach a persisted log. */
export function summarise(error: unknown): string {
  if (!(error instanceof Error)) return "unknown pics error";
  return `${error.name}: ${error.message}`.replace(
    /postgres(?:ql)?:\/\/[^\s]+/gi,
    "[redacted database URL]",
  );
}
