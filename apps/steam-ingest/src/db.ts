import { neon } from "@neondatabase/serverless";
import { assertDatabaseUrl } from "@heimdall/shared";

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

export const TRACKED_APPS_SQL = `select appid, poll_tier
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
   set poll_tier = 0, parked_at = now()
 where a.poll_tier > 0
   and coalesce(a.tracking_reason, '') not in ('curated-benchmark', 'charts')
   -- Only judge an app we have actually watched for a day; a new entrant must
   -- not be parked before it has had a chance to draw a crowd.
   --
   -- Asked of the APP, never of its samples. Keying this on "has a player-count
   -- row older than a day" exempted exactly the class this pass exists to shed:
   -- Steam answers "result != 1" for DLC, tools, demos and soundtracks, the
   -- players lane writes no row for those, and the guard was false for them
   -- forever. promoted_at (0043), not first_seen_at, is the start of the
   -- CURRENT tracked stretch, so a title the charts just re-promoted gets its
   -- own day rather than being judged on the week it spent parked.
   and coalesce(a.promoted_at, a.first_seen_at) <= now() - interval '24 hours'
   and coalesce((
     select max(p.players) from steam_player_counts p
      where p.appid = a.appid and p.bucket >= now() - interval '7 days'
   ), 0) < $1::integer
returning a.appid`;

/**
 * Resolve canonical games to Steam appids (8.7.9).
 *
 * This is the join that turns the whole 8.7 dimension into a feature: without
 * it `steam_app_updates` is a pile of announcements no run can reach, and the
 * sentence this phase exists to produce — "this title patched between your two
 * captures" — cannot be written.
 *
 * A WRONG LINK IS WORSE THAN NO LINK. It does not fail loudly; it silently
 * annotates a run with another game's patch history, which is exactly the kind
 * of confident-and-wrong output §0.5 exists to prevent. So the matcher is the
 * conservative token-overlap rule the driver curator already uses (score >=
 * 0.82 of the larger token count, and the winner must beat the runner-up by
 * 0.08 or be an exact name match), plus two guards this direction needs:
 *
 * 1. STEAM MUST CALL IT A GAME. A DLC, demo, soundtrack or tool shares nearly
 *    every token with its base title — "Cyberpunk 2077: Phantom Liberty" scores
 *    far above any threshold against "Cyberpunk 2077". No score separates those;
 *    `app_type` does. Apps whose metadata the catalog lane has not fetched yet
 *    have a null app_type and simply wait for the next pass, so coverage heals
 *    itself rather than guessing early.
 * 2. MUTUAL BEST. `games_steam_appid_key` allows one app per game, so a pair is
 *    only taken when the game is that app's best candidate AND the app is that
 *    game's best. Two remasters competing for one appid resolve to neither.
 *
 * Reentrant and additive: it only ever fills a null, so an operator's hand-made
 * link is never second-guessed and a re-run costs nothing.
 */
export const LINK_GAMES_TO_STEAM_APPS_SQL = `with normalized_games as (
  select g.id as game_id, tokens.value as tokens, names.value as normalized_name
    from games g
   cross join lateral (select regexp_replace(lower(g.name), '[^[:alnum:]]+', ' ', 'g')) as names(value)
   cross join lateral (select regexp_split_to_array(btrim(names.value), '\\s+')) as tokens(value)
   where g.steam_appid is null
   union all
  -- The capture sources' own names for the same game, which is often the form
  -- that matches a store listing.
  select ga.game_id, tokens.value, names.value
    from game_aliases ga
    join games g on g.id = ga.game_id
   cross join lateral (select regexp_replace(lower(ga.normalized_name), '[^[:alnum:]]+', ' ', 'g')) as names(value)
   cross join lateral (select regexp_split_to_array(btrim(names.value), '\\s+')) as tokens(value)
   where g.steam_appid is null
), candidate_apps as (
  select a.appid, tokens.value as tokens, names.value as normalized_name
    from steam_apps a
   cross join lateral (select regexp_replace(lower(a.name), '[^[:alnum:]]+', ' ', 'g')) as names(value)
   cross join lateral (select regexp_split_to_array(btrim(names.value), '\\s+')) as tokens(value)
   where a.app_type = 'game'
     and not exists (select 1 from games linked where linked.steam_appid = a.appid)
), scored as (
  select n.game_id,
         c.appid,
         max(case when n.normalized_name = c.normalized_name then 3 else 1 end) as priority,
         max(overlap.score) as score
    from normalized_games n
    join candidate_apps c on n.tokens && c.tokens
   cross join lateral (
     select count(*)::real /
            greatest(cardinality(n.tokens), cardinality(c.tokens), 1) as score
       from (
         select unnest(n.tokens) as token
         intersect
         select unnest(c.tokens) as token
       ) shared_tokens
   ) overlap
   group by n.game_id, c.appid
), ranked as (
  select scored.*,
         row_number() over w_game as game_rank,
         lead(priority) over w_game as next_game_priority,
         lead(score) over w_game as next_game_score,
         row_number() over w_app as app_rank,
         lead(priority) over w_app as next_app_priority,
         lead(score) over w_app as next_app_score
    from scored
   where score >= 0.82
  window w_game as (partition by game_id order by priority desc, score desc, appid),
         w_app as (partition by appid order by priority desc, score desc, game_id)
), resolved as (
  select game_id, appid
    from ranked
   where game_rank = 1
     and app_rank = 1
     -- Unambiguous in BOTH directions, with no exact-match escape hatch. The
     -- driver curator lets an exact name win outright because it resolves
     -- against a dictionary where the name IS the key; here two distinct games
     -- can carry the same name and two apps can carry the same title, and a tie
     -- broken on id order is a coin flip presented as a fact. Both sides must
     -- beat their runner-up on priority or clear the 0.08 margin.
     and (
       next_game_priority is null
       or priority > next_game_priority
       or score - next_game_score >= 0.08
     )
     and (
       next_app_priority is null
       or priority > next_app_priority
       or score - next_app_score >= 0.08
     )
)
update games g
   set steam_appid = r.appid
  from resolved r
 where g.id = r.game_id
   and g.steam_appid is null
returning g.id`;

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
      -- A hand-narrowed row has a null parked_at, so it takes the least
      -- branch below and is untouched by any amount of re-discovery.
      --
      -- The POLLER's own parking is the exception, and it has to be: the
      -- demotion pass promises "an app that takes off is re-promoted by the
      -- charts source the moment it charts", and least() alone made tier 0
      -- absorbing, so a title parked during a quiet week and then charting at
      -- number one stayed dark forever. CHARTS ONLY — featured re-discovery is
      -- the noise the parking pass exists to shed, and letting it un-park would
      -- put the working set straight back on the treadmill.
      --
      -- One re-promotion decides all three columns, so it is named once and
      -- they are assigned together: a tier that moved without its dates, or
      -- dates without the tier, is the same silent half-state the 0043 comment
      -- describes. Re-promotion also starts a NEW tracked stretch, which is
      -- what buys the app its day of grace before the demotion pass can judge
      -- it again on the empty week it spent at tier 0.
      (poll_tier, promoted_at, parked_at) = (
        select case when r.repromote then excluded.poll_tier
                    else least(steam_apps.poll_tier, excluded.poll_tier) end,
               case when r.repromote then now() else steam_apps.promoted_at end,
               case when r.repromote then null else steam_apps.parked_at end
          from (select steam_apps.parked_at is not null
                   and excluded.tracking_reason = 'charts') as r(repromote)
      ),
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

/**
 * One app in the working set. The tier rides along because the lanes have to
 * spend a finite per-run budget on it: `steam_apps.poll_tier` declares which
 * apps are the high-cadence set, and a lane that reads only appids has no way
 * to honour that.
 */
export interface TrackedApp {
  appid: number;
  pollTier: number;
}

export interface TrackedAppSeed {
  appid: number;
  name: string;
  pollTier: number;
  trackingReason: string;
}

/** A Neon-backed executor. Kept separate so every write path is unit-testable. */
export function executorFor(databaseUrl: string): SqlExecutor {
  assertDatabaseUrl(databaseUrl);
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
): Promise<TrackedApp[]> {
  const rows = await execute<{ appid: string | number; poll_tier: string | number }>(
    TRACKED_APPS_SQL,
    [pollTier],
  );
  // Neon returns bigint as a string to avoid a lossy Number cast; appids are far
  // below 2^53, so narrowing here is safe and keeps the rest of the app numeric.
  return rows
    .map((row) => ({ appid: Number(row.appid), pollTier: Number(row.poll_tier) }))
    .filter((app) => Number.isSafeInteger(app.appid));
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

/** Fills `games.steam_appid` for every game the matcher can resolve safely. */
export async function linkGamesToSteamApps(execute: SqlExecutor): Promise<number> {
  const rows = await execute<{ id: string }>(LINK_GAMES_TO_STEAM_APPS_SQL, []);
  return rows.length;
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
