import {
  demoteInactiveApps,
  readKnownAppIds,
  readStaleCatalogApps,
  readTrackedApps,
  upsertTrackedApps,
  linkGamesToSteamApps,
  writeAppMetadata,
  writeAppUpdates,
  writePlayerCounts,
  writePriceSnapshots,
  writeReviewSnapshots,
  type SqlExecutor,
  type TrackedApp,
} from "./db";
import { mapWithConcurrency } from "./fetch";
import {
  bucketFor,
  fetchAppMetadata,
  fetchAppName,
  fetchAppUpdates,
  fetchFeaturedApps,
  fetchTopAppIds,
  fetchPlayerCount,
  fetchPriceBatch,
  fetchReviewSummary,
  LANE_CADENCE_MS,
  PRICE_BATCH_SIZE,
} from "./sources";
import { summariseError } from "@heimdall/shared";

import { POLL_TIER, TRACKING_REASON } from "./types";
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
  /** Apps priced per run. Costs ceil(n / PRICE_BATCH_SIZE) per country. */
  priceApps: number;
  catalogApps: number;
  concurrency: number;
  /** Names cost one subrequest each and cannot be batched — cap per run. */
  nameLookups: number;
  /** Peak players over the last week below which a discovered app is parked. */
  inactivePlayerThreshold: number;
}

export const LANE_LIMITS: LaneLimits = {
  playerApps: 400,
  reviewApps: 300,
  // Batching makes this the cheapest lane per app — 1000 apps is 20 subrequests
  // per country — but "cheapest" is not "free", and it was the one lane with no
  // cap at all: its cost grew with the working set and multiplies with every
  // country added to PRICE_COUNTRIES.
  priceApps: 1000,
  catalogApps: 80,
  concurrency: 6,
  nameLookups: 60,
  inactivePlayerThreshold: 50,
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
  return summariseError(error, "unknown ingest error");
}

function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    out.push(items.slice(index, index + size));
  }
  return out;
}

/**
 * Partition into fixed windows and advance one per run.
 *
 * The index comes from the lane's own cadence, never from stored state: a
 * retried, duplicated or overlapping invocation inside one cadence window lands
 * on the same index, re-polls the same apps and collapses onto the same
 * `bucket` key — the idempotence the whole bucket design rests on.
 */
function rotate(apps: readonly number[], limit: number, now: Date, cadenceMs: number): number[] {
  if (apps.length <= limit) return [...apps];
  const windows = Math.ceil(apps.length / limit);
  const index = Math.floor(now.getTime() / cadenceMs) % windows;
  return apps.slice(index * limit, index * limit + limit);
}

/**
 * The slice of the working set THIS run polls.
 *
 * A cap with no rotation is a permanent blind spot, not a budget. TRACKED_APPS_SQL
 * orders deterministically (`poll_tier asc, appid asc`), so a plain
 * `slice(0, limit)` polls the same head every run and an app sorting past the
 * cut is never sampled once, however long the poller runs. Rotating covers
 * every app once per `ceil(n / limit)` runs at exactly the same cost per run.
 * The catalog lane already does this in SQL, by staleness; these lanes have no
 * column to sort on, so the rotation is positional.
 *
 * Tier 1 is EXEMPT from the rotation, because rotating it would quietly delete
 * the distinction `poll_tier` exists to draw: the schema calls tier 1 the high
 * cadence set and tier 2 standard, and the old `slice(0, limit)` honoured that
 * only by accident of the tier-ascending sort. So the declared set is polled
 * every run and the rotation spends whatever budget is left on the rest. Only
 * when tier 1 alone overruns the cap does it rotate too — at that point the cap
 * is the binding constraint and something has to give.
 */
export function pollWindow(
  apps: readonly TrackedApp[],
  limit: number,
  now: Date,
  cadenceMs: number,
): number[] {
  if (!Number.isInteger(limit) || limit < 1) throw new Error("app cap must be a positive integer");
  const pinned: number[] = [];
  const rotating: number[] = [];
  for (const app of apps) {
    (app.pollTier === POLL_TIER.high ? pinned : rotating).push(app.appid);
  }
  if (pinned.length >= limit) return rotate(pinned, limit, now, cadenceMs);
  return [...pinned, ...rotate(rotating, limit - pinned.length, now, cadenceMs)];
}

async function runPlayersLane(deps: ResolvedDeps): Promise<LaneReport> {
  const { execute, fetchImpl, limits, now } = deps;
  const apps = pollWindow(
    await readTrackedApps(execute),
    limits.playerApps,
    now,
    LANE_CADENCE_MS.players,
  );
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
  const apps = pollWindow(
    await readTrackedApps(execute),
    limits.reviewApps,
    now,
    LANE_CADENCE_MS.reviews,
  );
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
  const apps = pollWindow(
    await readTrackedApps(execute),
    limits.priceApps,
    now,
    LANE_CADENCE_MS.prices,
  );
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
  //
  // Charts before featured, deliberately. Featured ranks what the store is
  // PROMOTING; the charts rank what people are PLAYING. Seeding from featured
  // alone filled ~half the working set with titles that never reported more
  // than single digits, each costing a subrequest every ten minutes.
  let appsDiscovered = 0;
  try {
    const ranked = await fetchTopAppIds({ fetchImpl });
    const known = await readKnownAppIds(execute, ranked);
    // Names are one subrequest each and cannot be batched, so only ever pay for
    // appids we do not already carry. Steady state is the handful that entered
    // the charts today; the first run pays once.
    const unknown = ranked.filter((appid) => !known.has(appid)).slice(0, limits.nameLookups);
    const resolved = await mapWithConcurrency(unknown, limits.concurrency, async (appid) => ({
      appid,
      name: await fetchAppName(appid, { fetchImpl }),
    }));
    const seeds = resolved
      .filter((r) => r.ok && r.value.name)
      .map((r) => ({
        appid: (r as { value: { appid: number; name: string } }).value.appid,
        name: (r as { value: { appid: number; name: string } }).value.name,
        pollTier: POLL_TIER.high,
        trackingReason: TRACKING_REASON.charts,
      }));
    if (seeds.length > 0) appsDiscovered += await upsertTrackedApps(execute, seeds);
  } catch (error) {
    logger.warn("steam charts discovery failed", { error: errorSummary(error) });
  }

  // Featured stays as a SECOND source at a lower tier: it surfaces a release on
  // day one, before it has any chance to chart. The demotion pass below is what
  // keeps that from accumulating dead weight.
  try {
    const featured = await fetchFeaturedApps({ fetchImpl });
    if (featured.length > 0) {
      appsDiscovered += await upsertTrackedApps(
        execute,
        featured.map((app) => ({
          appid: app.appid,
          name: app.name,
          pollTier: POLL_TIER.standard,
          trackingReason: TRACKING_REASON.featured,
        })),
      );
    }
  } catch (error) {
    // Discovery is additive. Losing it costs new coverage, never existing rows,
    // so the refresh below still runs.
    logger.warn("steam featured discovery failed", { error: errorSummary(error) });
  }

  let appsParked = 0;
  try {
    appsParked = await demoteInactiveApps(execute, limits.inactivePlayerThreshold);
  } catch (error) {
    logger.warn("steam inactive demotion failed", { error: errorSummary(error) });
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

  // AFTER the metadata write, deliberately: the matcher only considers apps
  // Steam calls a game, and `app_type` arrives with the metadata this run just
  // fetched. Linking here lets a title discovered today be resolved today
  // rather than waiting a full cycle. Costs no subrequest — it is pure SQL —
  // and never overwrites a link, so a failure is losing a day, not data.
  let gamesLinked = 0;
  try {
    gamesLinked = await linkGamesToSteamApps(execute);
  } catch (error) {
    logger.warn("steam game linking failed", { error: errorSummary(error) });
  }

  return {
    lane: "catalog",
    appsPolled: apps.length,
    rowsWritten:
      metadataReport.upserted + metadataReport.tags + metadataReport.rawSnapshots + updateRows,
    appsFailed,
    changesRecorded: metadataReport.changes,
    appsDiscovered,
    appsParked,
    gamesLinked,
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
