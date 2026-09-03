-- Phase 8.7 — Steam ingest: the game-context dimension behind patch-annotated
-- performance analysis.
--
-- WHY THIS EXISTS. `games` is a five-column hand-seeded dictionary, which is the
-- exact staleness treadmill docs/driver-currency-curation.md calls out ("the
-- failure mode that rotted FlightlessMango"). Phase 6.6 fixed that for drivers
-- and left it unfixed for games. These tables are the scheduled equivalent.
--
-- The load-bearing table is `steam_app_updates`, not the time series. A run
-- carries a captured_at; an update carries a posted_at; joining them is what
-- lets a report say "this title patched between your two runs" instead of
-- reporting an unexplained 6 FPS delta. Player counts, prices and review
-- trajectories are cheap to collect alongside it and are worth having, but they
-- are context, not the reason.
--
-- These tables are a SEPARATE dimension, deliberately. `games` stays the
-- canonical dictionary that runs reference; Steam is one upstream that annotates
-- it via `games.steam_appid`. Nothing here is on the run-ingest hot path, and
-- every consumer must tolerate all of it being absent — an appid we have never
-- polled, a game with no Steam presence, and a poller that has been down for a
-- week are all normal states, never errors.
--
-- STORAGE. Player counts dominate row growth: one row per tracked app per poll.
-- 500 apps at a 10-minute cadence is ~72k rows/day, ~26M/year. That is fine in
-- Postgres and is NOT fine on a free tier forever; §28 (ClickHouse) is where
-- this time series belongs at scale, so the shapes below stay narrow, additive
-- and free of anything that would resist being copied there.

create table if not exists steam_apps (
  appid               bigint primary key,
  name                text not null,
  -- Steam's own `type`: game / dlc / demo / music / tool / …
  app_type            text,
  is_free             boolean,
  release_date        date,
  coming_soon         boolean,
  developers          text[],
  publishers          text[],
  first_seen_at       timestamptz not null default now(),
  metadata_fetched_at timestamptz,
  -- Poll cadence tier. 0 = known but never polled (the long tail of dead and
  -- junk apps); 1 = high cadence; 2 = standard. The poller reads this, so
  -- widening coverage is a data change, not a deploy.
  poll_tier           smallint not null default 2
                      constraint steam_apps_poll_tier_check
                      check (poll_tier between 0 and 2),
  -- Free text for why this app is tracked ('featured', 'heimdall-game', …).
  tracking_reason     text
);

-- The poller's working set. Partial so the eventual long tail of tier-0 apps
-- costs nothing to carry.
create index if not exists steam_apps_poll_tier_idx
  on steam_apps (poll_tier, appid)
  where poll_tier > 0;

-- `bucket` is the poll timestamp floored to the lane's cadence, which is what
-- makes every writer idempotent: a retried cron, an overlapping invocation and
-- a double deploy all collapse onto the same primary key instead of writing
-- near-duplicate rows a few seconds apart.
create table if not exists steam_player_counts (
  appid   bigint not null references steam_apps (appid) on delete cascade,
  bucket  timestamptz not null,
  players integer not null
          constraint steam_player_counts_players_check check (players >= 0),
  primary key (appid, bucket)
);

-- Serves "what was happening across the catalog at time T" without walking the
-- per-app primary key.
create index if not exists steam_player_counts_bucket_idx
  on steam_player_counts (bucket desc);

create table if not exists steam_review_snapshots (
  appid             bigint not null references steam_apps (appid) on delete cascade,
  bucket            timestamptz not null,
  -- Steam's 0-9 score band and its label ('Very Positive'). Nullable: an app
  -- below the review threshold reports totals with no band.
  review_score      smallint,
  review_score_desc text,
  total_positive    integer not null
                    constraint steam_review_snapshots_positive_check
                    check (total_positive >= 0),
  total_negative    integer not null
                    constraint steam_review_snapshots_negative_check
                    check (total_negative >= 0),
  total_reviews     integer not null
                    constraint steam_review_snapshots_total_check
                    check (total_reviews >= 0),
  primary key (appid, bucket)
);

-- Prices are per-country, so the country is part of the key rather than an
-- assumption that everything is USD.
create table if not exists steam_price_snapshots (
  appid            bigint not null references steam_apps (appid) on delete cascade,
  country_code     text not null
                   constraint steam_price_snapshots_country_check
                   check (country_code ~ '^[a-z]{2}$'),
  bucket           timestamptz not null,
  currency         text not null
                   constraint steam_price_snapshots_currency_check
                   check (currency ~ '^[A-Z]{3}$'),
  -- Minor units, exactly as Steam reports them. Never a float.
  initial_cents    integer not null
                   constraint steam_price_snapshots_initial_check
                   check (initial_cents >= 0),
  final_cents      integer not null
                   constraint steam_price_snapshots_final_check
                   check (final_cents >= 0),
  discount_percent smallint not null
                   constraint steam_price_snapshots_discount_check
                   check (discount_percent between 0 and 100),
  primary key (appid, country_code, bucket)
);

-- The table Heimdall actually needs. Keyed by Steam's own news `gid`, so
-- re-reading the same feed is a no-op and an edited announcement updates in
-- place rather than duplicating.
create table if not exists steam_app_updates (
  appid        bigint not null references steam_apps (appid) on delete cascade,
  gid          text not null,
  posted_at    timestamptz not null,
  title        text not null,
  url          text,
  feedname     text,
  -- Steam tags patch-note announcements; a title heuristic fills the gap for
  -- feeds that do not. False does not mean "not a patch" — it means we have no
  -- evidence either way, and consumers must treat it as unknown rather than as
  -- a negative. Same self-suppressing posture as the driver-currency rules.
  is_patchnote boolean not null default false,
  primary key (appid, gid)
);

-- "What shipped for this app between run A and run B" — the join that makes a
-- before/after delta explainable (§25–§26).
create index if not exists steam_app_updates_appid_posted_idx
  on steam_app_updates (appid, posted_at desc);

-- Genres and store categories, as Steam returns them alongside the metadata we
-- already fetch. `rank` preserves Steam's own ordering, which is meaningful —
-- the first genre is the primary one.
--
-- NOT user tags. The community tags SteamDB shows are not in any JSON endpoint;
-- they are embedded in the store page HTML. Adding them is a separate source
-- with a separate failure mode, so this table carries a `kind` from the start
-- rather than pretending genres are tags.
create table if not exists steam_app_tags (
  appid         bigint not null references steam_apps (appid) on delete cascade,
  kind          text not null
                constraint steam_app_tags_kind_check
                check (kind in ('genre', 'category', 'tag')),
  name          text not null,
  rank          smallint,
  first_seen_at timestamptz not null default now(),
  last_seen_at  timestamptz not null,
  primary key (appid, kind, name)
);

/*
 * Full-fidelity retention, deduplicated by content hash.
 *
 * "Store the raw response so you can backfill a field you did not model" is
 * right, and "store every daily response" is how that advice turns into tens of
 * gigabytes a year: one appdetails body is ~35 KB, and almost every day it is
 * byte-identical to yesterday's. Keying on the payload hash keeps ONE row per
 * distinct payload — a re-read that changed nothing bumps `last_seen_at` and
 * writes nothing else, while a real change writes a new row.
 *
 * The result is complete history at a few rows per app per year, and every
 * unmodelled field in this file (metacritic, platforms, dlc, packages, the
 * requirement blobs) stays recoverable without a schema change.
 */
create table if not exists steam_raw_snapshots (
  appid         bigint not null references steam_apps (appid) on delete cascade,
  source        text not null
                constraint steam_raw_snapshots_source_check
                check (source in ('appdetails', 'appreviews', 'news')),
  payload_hash  text not null
                constraint steam_raw_snapshots_hash_check
                check (payload_hash ~ '^[0-9a-f]{64}$'),
  payload       jsonb not null,
  first_seen_at timestamptz not null,
  last_seen_at  timestamptz not null,
  primary key (appid, source, payload_hash)
);

create index if not exists steam_raw_snapshots_appid_seen_idx
  on steam_raw_snapshots (appid, source, first_seen_at desc);

/*
 * Field-level change history, computed from our own snapshots.
 *
 * This is NOT SteamDB's change history. Theirs is the PICS changelist stream —
 * depots, manifests, build ids and appinfo config keys — which needs an
 * authenticated Steam network client (SteamKit2), not the Web API. What this
 * table honestly holds is every change to the metadata we actually observe.
 *
 * The same limit applies to engine detection: SteamDB infers "Unity" or
 * "Unreal" from depot FILE LISTS, which is depot access, not store metadata.
 * `games.engine` therefore stays hand-curated until a PICS collector exists.
 */
create table if not exists steam_app_changes (
  id          bigint generated always as identity primary key,
  appid       bigint not null references steam_apps (appid) on delete cascade,
  observed_at timestamptz not null,
  field       text not null,
  old_value   text,
  new_value   text
);

create index if not exists steam_app_changes_appid_observed_idx
  on steam_app_changes (appid, observed_at desc);

-- Annotate the canonical dictionary without letting Steam own it. Nullable
-- forever: plenty of benchmarked titles are not on Steam, and a null here must
-- never degrade a run, a report or an aggregate.
alter table games add column if not exists steam_appid bigint;

-- One Steam app maps to at most one canonical game. Partial, because null is
-- the common case and duplicate nulls are fine.
create unique index if not exists games_steam_appid_key
  on games (steam_appid)
  where steam_appid is not null;

-- `add constraint if not exists` does not exist in PostgreSQL, and this file
-- must stay reentrant like every other migration here.
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'games_steam_appid_fkey'
  ) then
    alter table games
      add constraint games_steam_appid_fkey
      foreign key (steam_appid) references steam_apps (appid) on delete set null;
  end if;
end
$$;
