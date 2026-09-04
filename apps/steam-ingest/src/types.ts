/** Phase 8.7 — Steam ingest contracts. */

/**
 * One scheduled collection lane. Each maps to its own cron in wrangler.jsonc and
 * its own `bucket` cadence, so lanes fail, retry and backfill independently.
 */
export type IngestLane = "players" | "reviews" | "prices" | "catalog";

/**
 * steam_apps.poll_tier (migration 0041). The poller reads this column, so
 * widening coverage is a data change rather than a deploy — which only works
 * while every reader agrees on what the numbers mean.
 */
export const POLL_TIER = {
  /** Known but not polled: the long tail, plus whatever the demotion pass parks. */
  parked: 0,
  high: 1,
  standard: 2,
} as const;

/**
 * steam_apps.tracking_reason — why an app is in the working set at all.
 *
 * The demotion and re-promotion rules turn on these strings, and db.ts writes
 * them into SQL text, which cannot interpolate a constant: every statement
 * there binds values only (see the statement-shape test). db.unit.test.ts
 * asserts the SQL and this table stay in step, so a rename fails loudly instead
 * of quietly matching nothing for the lifetime of the deploy.
 */
export const TRACKING_REASON = {
  charts: "charts",
  featured: "featured",
  curatedBenchmark: "curated-benchmark",
} as const;

export interface PlayerCountSample {
  appid: number;
  bucket: string;
  players: number;
}

export interface ReviewSample {
  appid: number;
  bucket: string;
  /** Steam's 0-9 band. Null below the review threshold — not zero. */
  reviewScore: number | null;
  reviewScoreDesc: string | null;
  totalPositive: number;
  totalNegative: number;
  totalReviews: number;
}

export interface PriceSample {
  appid: number;
  countryCode: string;
  bucket: string;
  currency: string;
  initialCents: number;
  finalCents: number;
  discountPercent: number;
}

/** A genre or store category, in the order Steam returned it. */
export interface AppTag {
  appid: number;
  kind: "genre" | "category" | "tag";
  name: string;
  rank: number;
  lastSeenAt: string;
}

/**
 * One upstream response, kept whole and addressed by content hash so an
 * unchanged re-read costs no new row. This is what makes a field we did not
 * model today recoverable tomorrow.
 */
export interface RawSnapshot {
  appid: number;
  source: "appdetails" | "appreviews" | "news";
  payloadHash: string;
  payload: unknown;
  seenAt: string;
}

export interface AppMetadata {
  appid: number;
  name: string;
  appType: string | null;
  isFree: boolean | null;
  releaseDate: string | null;
  comingSoon: boolean | null;
  developers: string[];
  publishers: string[];
  metadataFetchedAt: string;
  tags: AppTag[];
  raw: RawSnapshot;
}

/**
 * A Steam announcement. `isPatchnote` false means "no evidence either way",
 * never "confirmed not a patch" — consumers must treat it as unknown.
 */
export interface AppUpdate {
  appid: number;
  gid: string;
  postedAt: string;
  title: string;
  url: string | null;
  feedname: string | null;
  isPatchnote: boolean;
}

export interface CatalogBatch {
  metadata: AppMetadata[];
  updates: AppUpdate[];
}

export interface LaneReport {
  lane: IngestLane;
  appsPolled: number;
  rowsWritten: number;
  appsFailed: number;
  /** Catalog lane only: field-level metadata changes recorded this run. */
  changesRecorded?: number;
  /** Catalog lane only: apps newly added to the working set. */
  appsDiscovered?: number;
  /** Catalog lane only: apps parked at tier 0 for never drawing players. */
  appsParked?: number;
}

export interface IngestLogger {
  info(message: string, data?: Record<string, unknown>): void;
  warn(message: string, data?: Record<string, unknown>): void;
  error(message: string, data?: Record<string, unknown>): void;
}
