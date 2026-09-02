import {
  readStaleCatalogApps,
  readTrackedApps,
  upsertTrackedApps,
  writeAppMetadata,
  writeAppUpdates,
  writePlayerCounts,
  writePriceSnapshots,
  writeReviewSnapshots,
  type SqlExecutor,
} from "./db";
import { mapWithConcurrency } from "./fetch";
import {
  bucketFor,
  fetchAppMetadata,
  fetchAppUpdates,
  fetchFeaturedApps,
  fetchPlayerCount,
  fetchPriceBatch,
  fetchReviewSummary,
  LANE_CADENCE_MS,
  PRICE_BATCH_SIZE,
} from "./sources";
import type {
  AppMetadata,
  AppUpdate,
  IngestLane,
  IngestLogger,
  LaneReport,
  PlayerCountSample,
  PriceSample,
  ReviewSample,
} from "./types";

/**
 * Per-invocation caps.
 *
 * A Cloudflare Worker gets a finite subrequest budget per invocation (50 on the
 * free plan, 1000 on paid), and Steam rate-limits by IP. These numbers are the
 * contract between those two limits: `playerApps` costs one subrequest each,
 * `catalogApps` costs two, and prices cost one per PRICE_BATCH_SIZE apps.
 *
 * KEEP THE SUM UNDER YOUR PLAN'S BUDGET. The defaults below assume the paid
 * plan; on the free plan every value has to come down by an order of magnitude,
 * and the honest fix is a smaller working set, not a higher cap.
 */
export interface LaneLimits {
  playerApps: number;
  reviewApps: number;
  catalogApps: number;
  concurrency: number;
}

export const LANE_LIMITS: LaneLimits = {
  playerApps: 400,
  reviewApps: 300,
  catalogApps: 80,
  concurrency: 6,
};

/** Widen deliberately: every added country multiplies the price lane's rows. */
export const PRICE_COUNTRIES = ["us"] as const;

const defaultLogger: IngestLogger = {
  info: (message, data) => console.info(message, data ?? {}),
  warn: (message, data) => console.warn(message, data ?? {}),
  error: (message, data) => console.error(message, data ?? {}),
};

export interface IngestDeps {
  execute: SqlExecutor;
  fetchImpl?: typeof fetch;
  logger?: IngestLogger;
  now?: Date;
  limits?: Partial<LaneLimits>;
  priceCountries?: readonly string[];
}

/** Never let a connection string or a store payload reach a persisted log. */
export function errorSummary(error: unknown): string {
  if (!(error instanceof Error)) return "unknown ingest error";
  return `${error.name}: ${error.message}`.replace(
    /postgres(?:ql)?:\/\/[^\s]+/gi,
    "[redacted database URL]",
  );
}

function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    out.push(items.slice(index, index + size));
  }
  return out;
}

async function runPlayersLane(deps: ResolvedDeps): Promise<LaneReport> {
  const { execute, fetchImpl, limits, now } = deps;
  const apps = (await readTrackedApps(execute)).slice(0, limits.playerApps);
  const bucket = bucketFor(now, LANE_CADENCE_MS.players);
  const results = await mapWithConcurrency(apps, limits.concurrency, (appid) =>
    fetchPlayerCount(appid, { fetchImpl }),
  );
  const samples: PlayerCountSample[] = [];
  let appsFailed = 0;
  results.forEach((result, index) => {
    if (!result.ok) {
      appsFailed++;
      return;
    }
    // A null player count is Steam declining to report for this app (most DLC
    // and tools), not a failure — it must not burn the lane's error budget.
    if (result.value !== null) samples.push({ appid: apps[index]!, bucket, players: result.value });
  });
  return {
    lane: "players",
    appsPolled: apps.length,
    rowsWritten: await writePlayerCounts(execute, samples),
    appsFailed,
  };
}

async function runReviewsLane(deps: ResolvedDeps): Promise<LaneReport> {
  const { execute, fetchImpl, limits, now } = deps;
  const apps = (await readTrackedApps(execute)).slice(0, limits.reviewApps);
  const bucket = bucketFor(now, LANE_CADENCE_MS.reviews);
  const results = await mapWithConcurrency(apps, limits.concurrency, (appid) =>
    fetchReviewSummary(appid, bucket, { fetchImpl }),
  );
  const samples: ReviewSample[] = [];
  let appsFailed = 0;
  for (const result of results) {
    if (!result.ok) appsFailed++;
    else if (result.value) samples.push(result.value);
  }
  return {
    lane: "reviews",
    appsPolled: apps.length,
    rowsWritten: await writeReviewSnapshots(execute, samples),
    appsFailed,
  };
}

async function runPricesLane(deps: ResolvedDeps): Promise<LaneReport> {
  const { execute, fetchImpl, limits, now, priceCountries } = deps;
  const apps = await readTrackedApps(execute);
  const bucket = bucketFor(now, LANE_CADENCE_MS.prices);
  const batches = chunk(apps, PRICE_BATCH_SIZE).flatMap((batch) =>
    priceCountries.map((countryCode) => ({ batch, countryCode })),
  );
  const results = await mapWithConcurrency(batches, limits.concurrency, ({ batch, countryCode }) =>
    fetchPriceBatch(batch, countryCode, bucket, { fetchImpl }),
  );
  const samples: PriceSample[] = [];
  let appsFailed = 0;
  results.forEach((result, index) => {
    if (!result.ok) {
      // One failed request costs the whole batch it covered; count the apps, not
      // the request, so the report reflects lost coverage rather than lost calls.
      appsFailed += batches[index]!.batch.length;
      return;
    }
    samples.push(...result.value);
  });
  return {
    lane: "prices",
    appsPolled: apps.length,
    rowsWritten: await writePriceSnapshots(execute, samples),
    appsFailed,
  };
}

async function runCatalogLane(deps: ResolvedDeps): Promise<LaneReport> {
  const { execute, fetchImpl, limits, logger, now } = deps;

  // Discovery first, so a newly trending title is already tracked by the time
  // the staleness rotation below picks its slice.
  try {
    const featured = await fetchFeaturedApps({ fetchImpl });
    if (featured.length > 0) {
      await upsertTrackedApps(
        execute,
        featured.map((app) => ({
          appid: app.appid,
          name: app.name,
          pollTier: 1,
          trackingReason: "featured",
        })),
      );
    }
  } catch (error) {
    // Discovery is additive. Losing it costs new coverage, never existing rows,
    // so the refresh below still runs.
    logger.warn("steam featured discovery failed", { error: errorSummary(error) });
  }

  const apps = await readStaleCatalogApps(execute, limits.catalogApps);
  const fetchedAt = now.toISOString();
  const results = await mapWithConcurrency(apps, limits.concurrency, async (appid) => ({
    metadata: await fetchAppMetadata(appid, fetchedAt, { fetchImpl }),
    updates: await fetchAppUpdates(appid, { fetchImpl }),
  }));

  const metadata: AppMetadata[] = [];
  const updates: AppUpdate[] = [];
  let appsFailed = 0;
  for (const result of results) {
    if (!result.ok) {
      appsFailed++;
      continue;
    }
    if (result.value.metadata) metadata.push(result.value.metadata);
    updates.push(...result.value.updates);
  }
  const [metadataReport, updateRows] = await Promise.all([
    writeAppMetadata(execute, metadata),
    writeAppUpdates(execute, updates),
  ]);
  return {
    lane: "catalog",
    appsPolled: apps.length,
    rowsWritten:
      metadataReport.upserted + metadataReport.tags + metadataReport.rawSnapshots + updateRows,
    appsFailed,
    changesRecorded: metadataReport.changes,
  };
}

interface ResolvedDeps {
  execute: SqlExecutor;
  fetchImpl: typeof fetch | undefined;
  limits: LaneLimits;
  logger: IngestLogger;
  now: Date;
  priceCountries: readonly string[];
}

export async function runLane(lane: IngestLane, deps: IngestDeps): Promise<LaneReport> {
  const resolved: ResolvedDeps = {
    execute: deps.execute,
    fetchImpl: deps.fetchImpl,
    limits: { ...LANE_LIMITS, ...deps.limits },
    logger: deps.logger ?? defaultLogger,
    now: deps.now ?? new Date(),
    priceCountries: deps.priceCountries ?? PRICE_COUNTRIES,
  };
  switch (lane) {
    case "players":
      return runPlayersLane(resolved);
    case "reviews":
      return runReviewsLane(resolved);
    case "prices":
      return runPricesLane(resolved);
    case "catalog":
      return runCatalogLane(resolved);
  }
}
