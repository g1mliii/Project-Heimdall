import { fetchJson, type SafeFetchOptions } from "./fetch";
import type {
  AppMetadata,
  AppTag,
  AppUpdate,
  IngestLane,
  PriceSample,
  ReviewSample,
} from "./types";

/**
 * Poll cadence per lane, and therefore the `bucket` width that makes each
 * writer idempotent. Changing a value here changes the primary key spacing of
 * that lane's table — new buckets simply start landing on the new grid, so it
 * is safe, but it is not free: the series has a visible seam at the change.
 */
export const LANE_CADENCE_MS: Record<IngestLane, number> = {
  players: 10 * 60 * 1000,
  reviews: 60 * 60 * 1000,
  prices: 6 * 60 * 60 * 1000,
  catalog: 24 * 60 * 60 * 1000,
};

/**
 * Steam's price filter accepts a comma-separated appid list, which is the
 * difference between one subrequest per app and one per fifty. Kept well under
 * the point where the store starts truncating responses.
 */
export const PRICE_BATCH_SIZE = 50;

/** Steam's news feed caps out well below this; we only want recent items. */
const NEWS_ITEM_LIMIT = 20;

const MAX_NAME_LENGTH = 512;
const MAX_TITLE_LENGTH = 512;
const MAX_URL_LENGTH = 2048;

const NAMED_MONTHS: Record<string, number> = {
  jan: 1,
  feb: 2,
  mar: 3,
  apr: 4,
  may: 5,
  jun: 6,
  jul: 7,
  aug: 8,
  sep: 9,
  oct: 10,
  nov: 11,
  dec: 12,
};

/**
 * Titles Steam did not tag, in the feeds that never tag anything. Deliberately
 * conservative — a false negative leaves `is_patchnote` unknown, which every
 * consumer already tolerates, whereas a false positive would annotate a run
 * with an update that never happened.
 */
const PATCHNOTE_TITLE = /\b(?:patch|hotfix|update\s+\d|changelog|release\s+notes)\b/i;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Steam reports counts as JSON numbers; anything else is a shape change. */
function nonNegativeInt(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  const rounded = Math.trunc(value);
  if (rounded < 0 || rounded > Number.MAX_SAFE_INTEGER) return null;
  return rounded;
}

function boundedString(value: unknown, maxLength: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > maxLength) return null;
  return trimmed;
}

/** Floor `now` to the lane's cadence so retries collapse onto one row. */
export function bucketFor(now: Date, cadenceMs: number): string {
  if (!Number.isFinite(cadenceMs) || cadenceMs <= 0) {
    throw new Error("cadence must be a positive number of milliseconds");
  }
  return new Date(Math.floor(now.getTime() / cadenceMs) * cadenceMs).toISOString();
}

/**
 * Steam's store release strings are free text in the store's locale — "Dec 9,
 * 2020", "9 Dec, 2020", "2021", "Q1 2022", "Coming soon". Only the two exact
 * day forms are trusted; everything else returns null, because a wrong release
 * date is worse than a missing one for anything that reasons about age.
 */
export function parseReleaseDate(value: unknown): string | null {
  const raw = boundedString(value, 64);
  if (!raw) return null;
  const cleaned = raw.replace(/,/g, " ").replace(/\s+/g, " ").trim();
  const monthFirst = cleaned.match(/^([A-Za-z]{3,9})\s+(\d{1,2})\s+(\d{4})$/);
  const dayFirst = cleaned.match(/^(\d{1,2})\s+([A-Za-z]{3,9})\s+(\d{4})$/);
  const match = monthFirst ?? dayFirst;
  if (!match) return null;
  const monthName = (monthFirst ? match[1]! : match[2]!).slice(0, 3).toLowerCase();
  const day = Number(monthFirst ? match[2]! : match[1]!);
  const year = Number(match[3]!);
  const month = NAMED_MONTHS[monthName];
  if (!month || !Number.isInteger(day) || day < 1 || day > 31) return null;
  if (year < 1997 || year > 2100) return null;
  const iso = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  // Rejects Feb 31 and friends: Date normalises them to the next month.
  const parsed = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime()) || !parsed.toISOString().startsWith(iso)) return null;
  return iso;
}

function stringArray(value: unknown, limit = 16): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const entry of value) {
    const name = boundedString(entry, MAX_NAME_LENGTH);
    if (name) out.push(name);
    if (out.length >= limit) break;
  }
  return out;
}

export interface SourceDeps extends SafeFetchOptions {
  now?: Date;
}

/**
 * Current concurrent players. Keyless.
 *
 * Returns null when Steam answers with a non-success `result`, which it does
 * for apps that do not report player counts at all (most DLC and tools). That
 * is a normal answer, not a failure, so it must not count against the lane's
 * error budget.
 */
export async function fetchPlayerCount(appid: number, deps: SourceDeps = {}): Promise<number | null> {
  const url = `https://api.steampowered.com/ISteamUserStats/GetNumberOfCurrentPlayers/v1/?appid=${appid}`;
  const body = await fetchJson(url, deps);
  if (!isRecord(body) || !isRecord(body.response)) return null;
  if (body.response.result !== 1) return null;
  return nonNegativeInt(body.response.player_count);
}

/**
 * Review totals. Keyless.
 *
 * `num_per_page=0` asks for the summary without a single review body, which is
 * the whole payload in ~200 bytes.
 */
export async function fetchReviewSummary(
  appid: number,
  bucket: string,
  deps: SourceDeps = {},
): Promise<ReviewSample | null> {
  const url =
    `https://store.steampowered.com/appreviews/${appid}` +
    `?json=1&num_per_page=0&purchase_type=all&language=all`;
  const body = await fetchJson(url, deps);
  if (!isRecord(body) || body.success !== 1 || !isRecord(body.query_summary)) return null;
  const summary = body.query_summary;
  const totalPositive = nonNegativeInt(summary.total_positive);
  const totalNegative = nonNegativeInt(summary.total_negative);
  const totalReviews = nonNegativeInt(summary.total_reviews);
  if (totalPositive === null || totalNegative === null || totalReviews === null) return null;
  const score = nonNegativeInt(summary.review_score);
  return {
    appid,
    bucket,
    reviewScore: score !== null && score <= 9 ? score : null,
    reviewScoreDesc: boundedString(summary.review_score_desc, 64),
    totalPositive,
    totalNegative,
    totalReviews,
  };
}

/**
 * Prices for a batch of appids in one subrequest. Keyless.
 *
 * A free app answers `success: true` with an empty `data`, which is why the
 * per-app narrowing below treats a missing `price_overview` as "no row", not as
 * an error.
 */
export async function fetchPriceBatch(
  appids: readonly number[],
  countryCode: string,
  bucket: string,
  deps: SourceDeps = {},
): Promise<PriceSample[]> {
  if (appids.length === 0) return [];
  if (!/^[a-z]{2}$/.test(countryCode)) throw new Error("country code must be two lowercase letters");
  const url =
    `https://store.steampowered.com/api/appdetails` +
    `?appids=${appids.join(",")}&cc=${countryCode}&l=en&filters=price_overview`;
  const body = await fetchJson(url, deps);
  if (!isRecord(body)) return [];
  const samples: PriceSample[] = [];
  for (const appid of appids) {
    const entry = body[String(appid)];
    if (!isRecord(entry) || entry.success !== true || !isRecord(entry.data)) continue;
    const price = entry.data.price_overview;
    if (!isRecord(price)) continue;
    const currency = boundedString(price.currency, 3);
    const initialCents = nonNegativeInt(price.initial);
    const finalCents = nonNegativeInt(price.final);
    const discountPercent = nonNegativeInt(price.discount_percent);
    if (!currency || !/^[A-Z]{3}$/.test(currency)) continue;
    if (initialCents === null || finalCents === null || discountPercent === null) continue;
    if (discountPercent > 100) continue;
    samples.push({
      appid,
      countryCode,
      bucket,
      currency,
      initialCents,
      finalCents,
      discountPercent,
    });
  }
  return samples;
}

/**
 * The two keyless Steam charts endpoints, unioned.
 *
 * This is the RIGHT discovery source, and featuredcategories is not. Featured
 * ranks what the store is promoting, which on any given day is mostly tiny new
 * releases — the first seeding run pulled in ~40 apps with a single-digit
 * player count, which cost a subrequest every ten minutes to learn nothing.
 * These two rank by players: `GetGamesByConcurrentPlayers` is live CCU and
 * `GetMostPlayedGames` is the weekly peak, so the union is "currently busy" and
 * "reliably busy" rather than "currently advertised".
 *
 * Both return appids only, never names — see `fetchAppName`.
 */
export async function fetchTopAppIds(deps: SourceDeps = {}): Promise<number[]> {
  const endpoints = [
    "https://api.steampowered.com/ISteamChartsService/GetGamesByConcurrentPlayers/v1/",
    "https://api.steampowered.com/ISteamChartsService/GetMostPlayedGames/v1/",
  ];
  const ranked: number[] = [];
  const seen = new Set<number>();
  // Sequential and failure-tolerant: one chart being down must not cost the
  // other, and rank order is meaningful so the first list wins ties.
  for (const endpoint of endpoints) {
    let body: unknown;
    try {
      body = await fetchJson(endpoint, deps);
    } catch {
      continue;
    }
    if (!isRecord(body) || !isRecord(body.response) || !Array.isArray(body.response.ranks)) continue;
    for (const entry of body.response.ranks) {
      if (!isRecord(entry)) continue;
      const appid = nonNegativeInt(entry.appid);
      if (!appid || seen.has(appid)) continue;
      seen.add(appid);
      ranked.push(appid);
    }
  }
  return ranked;
}

/**
 * One app's name. `filters=basic` does NOT accept a comma-separated list the
 * way `filters=price_overview` does — every batch size tested returns HTTP 400 —
 * so this is unavoidably one subrequest per app. Callers must therefore resolve
 * names only for appids they do not already know, which keeps the steady-state
 * cost to the handful of titles that entered the charts that day.
 */
export async function fetchAppName(appid: number, deps: SourceDeps = {}): Promise<string | null> {
  const url = `https://store.steampowered.com/api/appdetails?appids=${appid}&cc=us&l=en&filters=basic`;
  const body = await fetchJson(url, deps);
  if (!isRecord(body)) return null;
  const entry = body[String(appid)];
  if (!isRecord(entry) || entry.success !== true || !isRecord(entry.data)) return null;
  // Steam is inconsistent about case here: appid 570 reports "game" and 730
  // reports "Game" in the same response shape. Compare case-insensitively.
  const type = boundedString(entry.data.type, 32)?.toLowerCase();
  if (type && type !== "game") return null;
  return boundedString(entry.data.name, MAX_NAME_LENGTH);
}

export interface FeaturedApp {
  appid: number;
  name: string;
}

/**
 * The store's own front-page groupings — top sellers, new releases, specials,
 * coming soon. Keyless, one subrequest, and the reason coverage does not need
 * the keyed full-catalog endpoint to grow: whatever people are actually playing
 * and buying surfaces here within a day of becoming relevant.
 */
export async function fetchFeaturedApps(deps: SourceDeps = {}): Promise<FeaturedApp[]> {
  const body = await fetchJson(
    "https://store.steampowered.com/api/featuredcategories?cc=us&l=en",
    deps,
  );
  if (!isRecord(body)) return [];
  const seen = new Map<number, string>();
  for (const category of Object.values(body)) {
    if (!isRecord(category) || !Array.isArray(category.items)) continue;
    for (const item of category.items) {
      if (!isRecord(item)) continue;
      const appid = nonNegativeInt(item.id);
      const name = boundedString(item.name, MAX_NAME_LENGTH);
      if (!appid || !name || seen.has(appid)) continue;
      seen.set(appid, name);
    }
  }
  return [...seen].map(([appid, name]) => ({ appid, name }));
}

/**
 * Content hash of a payload, over a key-sorted serialisation.
 *
 * Steam does not guarantee key order between responses, and an ordering change
 * alone must not read as a content change — that would defeat the whole point
 * of hashing and write a new snapshot row every day.
 */
export async function payloadHash(payload: unknown): Promise<string> {
  const canonical = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(canonical);
    if (!isRecord(value)) return value;
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonical(value[key])]),
    );
  };
  const bytes = new TextEncoder().encode(JSON.stringify(canonical(payload)));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Genres and store categories, preserving Steam's ordering in `rank`. */
function parseTags(data: Record<string, unknown>, appid: number, lastSeenAt: string): AppTag[] {
  const tags: AppTag[] = [];
  const collect = (value: unknown, kind: "genre" | "category"): void => {
    if (!Array.isArray(value)) return;
    let rank = 0;
    for (const entry of value) {
      if (!isRecord(entry)) continue;
      const name = boundedString(entry.description, 128);
      if (!name) continue;
      // Steam repeats a description occasionally; the primary key would reject
      // the duplicate and abort the batch, so collapse it here instead.
      if (tags.some((tag) => tag.kind === kind && tag.name === name)) continue;
      tags.push({ appid, kind, name, rank: rank++, lastSeenAt });
    }
  };
  collect(data.genres, "genre");
  collect(data.categories, "category");
  return tags;
}

/** Full store metadata for one app. Keyless, but one subrequest per app. */
export async function fetchAppMetadata(
  appid: number,
  fetchedAt: string,
  deps: SourceDeps = {},
): Promise<AppMetadata | null> {
  const url = `https://store.steampowered.com/api/appdetails?appids=${appid}&cc=us&l=en`;
  const body = await fetchJson(url, deps);
  if (!isRecord(body)) return null;
  const entry = body[String(appid)];
  if (!isRecord(entry) || entry.success !== true || !isRecord(entry.data)) return null;
  const data = entry.data;
  const name = boundedString(data.name, MAX_NAME_LENGTH);
  if (!name) return null;
  const releaseDate = isRecord(data.release_date) ? data.release_date : undefined;
  return {
    appid,
    name,
    appType: boundedString(data.type, 32),
    isFree: typeof data.is_free === "boolean" ? data.is_free : null,
    releaseDate: parseReleaseDate(releaseDate?.date),
    comingSoon: typeof releaseDate?.coming_soon === "boolean" ? releaseDate.coming_soon : null,
    developers: stringArray(data.developers),
    publishers: stringArray(data.publishers),
    metadataFetchedAt: fetchedAt,
    tags: parseTags(data, appid, fetchedAt),
    // The WHOLE response body, not the fields above. metacritic, platforms,
    // dlc, packages and the requirement blobs all ride along unparsed and stay
    // recoverable without a migration.
    raw: {
      appid,
      source: "appdetails",
      payloadHash: await payloadHash(data),
      payload: data,
      seenAt: fetchedAt,
    },
  };
}

/**
 * Announcements for one app, patch-note flagged. Keyless.
 *
 * This is the lane Heimdall actually needs: `posted_at` is what lets a
 * before/after delta say which patch landed between two captures.
 */
export async function fetchAppUpdates(appid: number, deps: SourceDeps = {}): Promise<AppUpdate[]> {
  const url =
    `https://api.steampowered.com/ISteamNews/GetNewsForApp/v2/` +
    `?appid=${appid}&count=${NEWS_ITEM_LIMIT}&maxlength=1`;
  const body = await fetchJson(url, deps);
  if (!isRecord(body) || !isRecord(body.appnews) || !Array.isArray(body.appnews.newsitems)) {
    return [];
  }
  const updates: AppUpdate[] = [];
  for (const item of body.appnews.newsitems) {
    if (!isRecord(item)) continue;
    const gid = boundedString(item.gid, 64);
    const title = boundedString(item.title, MAX_TITLE_LENGTH);
    const epochSeconds = nonNegativeInt(item.date);
    if (!gid || !title || epochSeconds === null) continue;
    const postedAt = new Date(epochSeconds * 1000);
    if (Number.isNaN(postedAt.getTime())) continue;
    const tags = Array.isArray(item.tags) ? item.tags : [];
    const url = boundedString(item.url, MAX_URL_LENGTH);
    updates.push({
      appid,
      gid,
      postedAt: postedAt.toISOString(),
      title,
      url: url && /^https?:\/\//i.test(url) ? url : null,
      feedname: boundedString(item.feedname, 64),
      isPatchnote: tags.includes("patchnotes") || PATCHNOTE_TITLE.test(title),
    });
  }
  return updates;
}
