import { neon } from "@neondatabase/serverless";

import type { AppMetadata, AppUpdate, PlayerCountSample, PriceSample, ReviewSample } from "./types";

/**
 * Every statement here binds exactly ONE parameter — a jsonb array of the whole
 * batch — so there is no hand-counted `$n` offset to get wrong and no need for
 * the `SqlParams` accumulator the web app's multi-fragment CTEs use. Adding a
 * second parameter to any of these is the signal to reach for that instead.
 *
 * The `where exists` guards are not redundant with the foreign keys. A single
 * unknown appid in a batch would make the FK abort the entire multi-row insert,
 * discarding every good sample alongside it; filtering keeps one bad row from
 * costing a poll cycle.
 */

export const TRACKED_APPS_SQL = `select appid
  from steam_apps
 where poll_tier > 0
   and ($1::smallint is null or poll_tier = $1::smallint)
 order by poll_tier asc, appid asc`;

/**
 * The catalog lane's rotation. Metadata and news cost two subrequests per app,
 * so a daily run refreshes the stalest slice rather than the whole working set —
 * never-fetched apps first, then oldest. Coverage grows without any run ever
 * risking the Worker's subrequest budget.
 */
export const STALE_CATALOG_APPS_SQL = `select appid
  from steam_apps
 where poll_tier > 0
 order by metadata_fetched_at asc nulls first, appid asc
 limit $1::integer`;

/** Which of these appids do we already carry? Drives name-lookup cost. */
export const KNOWN_APPIDS_SQL = `select a.appid
  from steam_apps a
  join jsonb_array_elements_text($1::jsonb) as x(appid) on a.appid = x.appid::bigint`;

/**
 * Park apps that have proven they are not worth a slot.
 *
 * Featured discovery pulls in whatever the store is promoting, which is mostly
 * tiny new releases: the first seeding run added ~40 apps that never reported
 * more than single-digit players, and each cost a subrequest every ten minutes
 * forever. Without this the working set only grows, and it grows with noise.
 *
 * Parking is tier 0, never deletion — the collected history stays, and an app
 * that takes off is re-promoted by the charts source the moment it charts.
 * Deliberate choices are exempt: a curated benchmark title is tracked because
 * someone decided it matters, not because it was busy this week.
 */
export const DEMOTE_INACTIVE_APPS_SQL = `update steam_apps a
   set poll_tier = 0
 where a.poll_tier > 0
   and coalesce(a.tracking_reason, '') not in ('curated-benchmark', 'charts')
   -- Only judge an app we have actually watched for a day; a new entrant must
   -- not be parked before it has had a chance to report anything.
   and exists (
     select 1 from steam_player_counts p
      where p.appid = a.appid and p.bucket <= now() - interval '24 hours'
   )
   and coalesce((
     select max(p.players) from steam_player_counts p
      where p.appid = a.appid and p.bucket >= now() - interval '7 days'
   ), 0) < $1::integer
returning a.appid`;

export const UPSERT_APPS_SQL = `insert into steam_apps (appid, name, poll_tier, tracking_reason)
select appid, name, poll_tier, tracking_reason
  from jsonb_to_recordset($1::jsonb) as x(
    appid bigint,
    name text,
    poll_tier smallint,
    tracking_reason text
  )
on conflict (appid) do update
  set name = excluded.name,
      -- Never silently widen coverage on re-discovery: an operator who parked an
      -- app at tier 0 keeps it there, and a re-seed only ever tightens cadence.
      poll_tier = least(steam_apps.poll_tier, excluded.poll_tier),
      tracking_reason = coalesce(steam_apps.tracking_reason, excluded.tracking_reason)
returning 1`;

export const INSERT_PLAYER_COUNTS_SQL = `insert into steam_player_counts (appid, bucket, players)
select x.appid, x.bucket, x.players
  from jsonb_to_recordset($1::jsonb) as x(
    appid bigint,
    bucket timestamptz,
    players integer
  )
 where exists (select 1 from steam_apps a where a.appid = x.appid)
on conflict (appid, bucket) do nothing
returning 1`;

export const INSERT_REVIEW_SNAPSHOTS_SQL = `insert into steam_review_snapshots (
  appid, bucket, review_score, review_score_desc,
  total_positive, total_negative, total_reviews
)
select x.appid, x.bucket, x.review_score, x.review_score_desc,
       x.total_positive, x.total_negative, x.total_reviews
  from jsonb_to_recordset($1::jsonb) as x(
    appid bigint,
    bucket timestamptz,
    review_score smallint,
    review_score_desc text,
    total_positive integer,
    total_negative integer,
    total_reviews integer
  )
 where exists (select 1 from steam_apps a where a.appid = x.appid)
on conflict (appid, bucket) do nothing
returning 1`;

export const INSERT_PRICE_SNAPSHOTS_SQL = `insert into steam_price_snapshots (
  appid, country_code, bucket, currency, initial_cents, final_cents, discount_percent
)
select x.appid, x.country_code, x.bucket, x.currency,
       x.initial_cents, x.final_cents, x.discount_percent
  from jsonb_to_recordset($1::jsonb) as x(
    appid bigint,
    country_code text,
    bucket timestamptz,
    currency text,
    initial_cents integer,
    final_cents integer,
    discount_percent smallint
  )
 where exists (select 1 from steam_apps a where a.appid = x.appid)
on conflict (appid, country_code, bucket) do nothing
returning 1`;

/**
 * Metadata upsert AND field-level change log, in one statement.
 *
 * The `prior` CTE is what makes the change log exact: a CTE sees the snapshot
 * the statement started with, so it reads the OLD row even though the upsert
 * runs in the same statement. Diffing in the application instead would need a
 * separate read and would race any concurrent writer between the two.
 */
export const UPSERT_APP_METADATA_SQL = `with input as (
  select *
    from jsonb_to_recordset($1::jsonb) as x(
      appid bigint,
      name text,
      app_type text,
      is_free boolean,
      release_date date,
      coming_soon boolean,
      developers text[],
      publishers text[],
      metadata_fetched_at timestamptz
    )
), prior as (
  select s.appid, s.name, s.app_type, s.is_free, s.release_date, s.coming_soon,
         s.developers, s.publishers, s.metadata_fetched_at
    from steam_apps s
    join input i on i.appid = s.appid
), changed as (
  insert into steam_app_changes (appid, observed_at, field, old_value, new_value)
  select i.appid, i.metadata_fetched_at, d.field, d.old_value, d.new_value
    from input i
    join prior p on p.appid = i.appid
   cross join lateral (values
     ('name', p.name, i.name),
     ('app_type', p.app_type, i.app_type),
     ('is_free', p.is_free::text, i.is_free::text),
     ('release_date', p.release_date::text, i.release_date::text),
     ('coming_soon', p.coming_soon::text, i.coming_soon::text),
     ('developers', array_to_string(p.developers, ', '), array_to_string(i.developers, ', ')),
     ('publishers', array_to_string(p.publishers, ', '), array_to_string(i.publishers, ', '))
   ) as d(field, old_value, new_value)
   -- A change needs a PRIOR OBSERVATION to be a change. An app seeded by
   -- discovery has a row but no metadata read yet, so its columns are null;
   -- logging null -> value for every field on first read would bury the real
   -- changes under one noise entry per field per app. A staler read than the
   -- one already stored is not a change either.
   where d.old_value is distinct from d.new_value
     and p.metadata_fetched_at is not null
     and i.metadata_fetched_at > p.metadata_fetched_at
  returning 1
), upserted as (
  insert into steam_apps (
    appid, name, app_type, is_free, release_date, coming_soon,
    developers, publishers, metadata_fetched_at
  )
  select i.appid, i.name, i.app_type, i.is_free, i.release_date, i.coming_soon,
         coalesce(i.developers, '{}'), coalesce(i.publishers, '{}'), i.metadata_fetched_at
    from input i
  on conflict (appid) do update
    set name = excluded.name,
        app_type = excluded.app_type,
        is_free = excluded.is_free,
        release_date = excluded.release_date,
        coming_soon = excluded.coming_soon,
        developers = excluded.developers,
        publishers = excluded.publishers,
        metadata_fetched_at = excluded.metadata_fetched_at
    -- A slow lane must never overwrite a fresher read with a staler one.
    where excluded.metadata_fetched_at > coalesce(steam_apps.metadata_fetched_at, 'epoch'::timestamptz)
  returning 1
)
select (select count(*)::integer from upserted) as upserted,
       (select count(*)::integer from changed) as changes`;

/**
 * A tag that disappears upstream keeps its row with a stale `last_seen_at`
 * rather than being deleted — the same self-suppressing posture the driver
 * rules use. Readers filter on freshness; nothing here destroys history.
 */
export const UPSERT_APP_TAGS_SQL = `insert into steam_app_tags (
  appid, kind, name, rank, last_seen_at
)
select x.appid, x.kind, x.name, x.rank, x.last_seen_at
  from jsonb_to_recordset($1::jsonb) as x(
    appid bigint,
    kind text,
    name text,
    rank smallint,
    last_seen_at timestamptz
  )
 where exists (select 1 from steam_apps a where a.appid = x.appid)
on conflict (appid, kind, name) do update
  set rank = excluded.rank,
      last_seen_at = greatest(steam_app_tags.last_seen_at, excluded.last_seen_at)
returning 1`;

/**
 * Content-addressed retention. An unchanged payload collides on its hash and
 * only advances `last_seen_at`, so a year of identical daily reads costs one
 * row; a real change writes a new one and the pair becomes the audit trail.
 */
export const UPSERT_RAW_SNAPSHOTS_SQL = `insert into steam_raw_snapshots (
  appid, source, payload_hash, payload, first_seen_at, last_seen_at
)
select x.appid, x.source, x.payload_hash, x.payload, x.seen_at, x.seen_at
  from jsonb_to_recordset($1::jsonb) as x(
    appid bigint,
    source text,
    payload_hash text,
    payload jsonb,
    seen_at timestamptz
  )
 where exists (select 1 from steam_apps a where a.appid = x.appid)
on conflict (appid, source, payload_hash) do update
  set last_seen_at = greatest(steam_raw_snapshots.last_seen_at, excluded.last_seen_at)
returning 1`;

export const UPSERT_APP_UPDATES_SQL = `insert into steam_app_updates (
  appid, gid, posted_at, title, url, feedname, is_patchnote
)
select x.appid, x.gid, x.posted_at, x.title, x.url, x.feedname, x.is_patchnote
  from jsonb_to_recordset($1::jsonb) as x(
    appid bigint,
    gid text,
    posted_at timestamptz,
    title text,
    url text,
    feedname text,
    is_patchnote boolean
  )
 where exists (select 1 from steam_apps a where a.appid = x.appid)
on conflict (appid, gid) do update
  set posted_at = excluded.posted_at,
      title = excluded.title,
      url = excluded.url,
      feedname = excluded.feedname,
      -- Latch: a later re-read that loses the tag must not un-flag a known
      -- patch note: false here means "no evidence", not "not a patch".
      is_patchnote = steam_app_updates.is_patchnote or excluded.is_patchnote
returning 1`;

export type SqlExecutor = <Row>(text: string, params: readonly unknown[]) => Promise<Row[]>;

export interface TrackedAppSeed {
  appid: number;
  name: string;
  pollTier: number;
  trackingReason: string;
}

function validateDatabaseUrl(value: string): void {
  const url = new URL(value);
  if (!(["postgres:", "postgresql:"] as string[]).includes(url.protocol) || !url.hostname) {
    throw new Error("DATABASE_URL must be a PostgreSQL connection string");
  }
}

/** A Neon-backed executor. Kept separate so every write path is unit-testable. */
export function executorFor(databaseUrl: string): SqlExecutor {
  validateDatabaseUrl(databaseUrl);
  const sql = neon(databaseUrl);
  return (<Row>(text: string, params: readonly unknown[]) =>
    sql.query(text, params as never[]) as unknown as Promise<Row[]>) as SqlExecutor;
}

async function writeBatch(
  execute: SqlExecutor,
  statement: string,
  rows: readonly unknown[],
): Promise<number> {
  if (rows.length === 0) return 0;
  const written = await execute<Record<string, unknown>>(statement, [JSON.stringify(rows)]);
  return written.length;
}

export async function readTrackedApps(
  execute: SqlExecutor,
  pollTier: number | null = null,
): Promise<number[]> {
  const rows = await execute<{ appid: string | number }>(TRACKED_APPS_SQL, [pollTier]);
  // Neon returns bigint as a string to avoid a lossy Number cast; appids are far
  // below 2^53, so narrowing here is safe and keeps the rest of the app numeric.
  return rows.map((row) => Number(row.appid)).filter((appid) => Number.isSafeInteger(appid));
}

export async function readStaleCatalogApps(
  execute: SqlExecutor,
  limit: number,
): Promise<number[]> {
  if (!Number.isInteger(limit) || limit < 1) throw new Error("catalog limit must be a positive integer");
  const rows = await execute<{ appid: string | number }>(STALE_CATALOG_APPS_SQL, [limit]);
  return rows.map((row) => Number(row.appid)).filter((appid) => Number.isSafeInteger(appid));
}

export async function readKnownAppIds(
  execute: SqlExecutor,
  appids: readonly number[],
): Promise<Set<number>> {
  if (appids.length === 0) return new Set();
  const rows = await execute<{ appid: string | number }>(KNOWN_APPIDS_SQL, [JSON.stringify(appids)]);
  return new Set(rows.map((row) => Number(row.appid)).filter((id) => Number.isSafeInteger(id)));
}

export async function demoteInactiveApps(
  execute: SqlExecutor,
  minPlayers: number,
): Promise<number> {
  if (!Number.isInteger(minPlayers) || minPlayers < 0) {
    throw new Error("minPlayers must be a non-negative integer");
  }
  const rows = await execute<{ appid: string }>(DEMOTE_INACTIVE_APPS_SQL, [minPlayers]);
  return rows.length;
}

export function upsertTrackedApps(
  execute: SqlExecutor,
  seeds: readonly TrackedAppSeed[],
): Promise<number> {
  // `insert ... on conflict do update` REFUSES a batch that touches one row
  // twice — Postgres raises "ON CONFLICT DO UPDATE command cannot affect row a
  // second time" and the whole batch is lost. Discovery sources overlap (a title
  // can be both charted and featured), so collapse duplicates here rather than
  // trusting every caller to. Last entry wins, matching the callers' priority.
  const deduped = [...new Map(seeds.map((seed) => [seed.appid, seed])).values()];
  return writeBatch(
    execute,
    UPSERT_APPS_SQL,
    deduped.map((seed) => ({
      appid: seed.appid,
      name: seed.name,
      poll_tier: seed.pollTier,
      tracking_reason: seed.trackingReason,
    })),
  );
}

export function writePlayerCounts(
  execute: SqlExecutor,
  samples: readonly PlayerCountSample[],
): Promise<number> {
  return writeBatch(execute, INSERT_PLAYER_COUNTS_SQL, samples);
}

export function writeReviewSnapshots(
  execute: SqlExecutor,
  samples: readonly ReviewSample[],
): Promise<number> {
  return writeBatch(
    execute,
    INSERT_REVIEW_SNAPSHOTS_SQL,
    samples.map((sample) => ({
      appid: sample.appid,
      bucket: sample.bucket,
      review_score: sample.reviewScore,
      review_score_desc: sample.reviewScoreDesc,
      total_positive: sample.totalPositive,
      total_negative: sample.totalNegative,
      total_reviews: sample.totalReviews,
    })),
  );
}

export function writePriceSnapshots(
  execute: SqlExecutor,
  samples: readonly PriceSample[],
): Promise<number> {
  return writeBatch(
    execute,
    INSERT_PRICE_SNAPSHOTS_SQL,
    samples.map((sample) => ({
      appid: sample.appid,
      country_code: sample.countryCode,
      bucket: sample.bucket,
      currency: sample.currency,
      initial_cents: sample.initialCents,
      final_cents: sample.finalCents,
      discount_percent: sample.discountPercent,
    })),
  );
}

export interface MetadataWriteReport {
  upserted: number;
  changes: number;
  tags: number;
  rawSnapshots: number;
}

/**
 * Writes the three things one catalog read produces: the normalised row (plus
 * its change log), the genre/category rows, and the whole raw payload.
 *
 * `steam_apps` is written FIRST because the other two are guarded on its rows
 * existing; the guards would silently drop everything for a newly seen app if
 * this ran in the other order.
 */
export async function writeAppMetadata(
  execute: SqlExecutor,
  metadata: readonly AppMetadata[],
): Promise<MetadataWriteReport> {
  const empty: MetadataWriteReport = { upserted: 0, changes: 0, tags: 0, rawSnapshots: 0 };
  if (metadata.length === 0) return empty;

  const [report] = await execute<{ upserted: number; changes: number }>(UPSERT_APP_METADATA_SQL, [
    JSON.stringify(
      metadata.map((row) => ({
        appid: row.appid,
        name: row.name,
        app_type: row.appType,
        is_free: row.isFree,
        release_date: row.releaseDate,
        coming_soon: row.comingSoon,
        developers: row.developers,
        publishers: row.publishers,
        metadata_fetched_at: row.metadataFetchedAt,
      })),
    ),
  ]);

  const [tags, rawSnapshots] = await Promise.all([
    writeBatch(
      execute,
      UPSERT_APP_TAGS_SQL,
      metadata.flatMap((row) =>
        row.tags.map((tag) => ({
          appid: tag.appid,
          kind: tag.kind,
          name: tag.name,
          rank: tag.rank,
          last_seen_at: tag.lastSeenAt,
        })),
      ),
    ),
    writeBatch(
      execute,
      UPSERT_RAW_SNAPSHOTS_SQL,
      metadata.map((row) => ({
        appid: row.raw.appid,
        source: row.raw.source,
        payload_hash: row.raw.payloadHash,
        payload: row.raw.payload,
        seen_at: row.raw.seenAt,
      })),
    ),
  ]);

  return {
    upserted: Number(report?.upserted ?? 0),
    changes: Number(report?.changes ?? 0),
    tags,
    rawSnapshots,
  };
}

export function writeAppUpdates(
  execute: SqlExecutor,
  updates: readonly AppUpdate[],
): Promise<number> {
  return writeBatch(
    execute,
    UPSERT_APP_UPDATES_SQL,
    updates.map((row) => ({
      appid: row.appid,
      gid: row.gid,
      posted_at: row.postedAt,
      title: row.title,
      url: row.url,
      feedname: row.feedname,
      is_patchnote: row.isPatchnote,
    })),
  );
}
