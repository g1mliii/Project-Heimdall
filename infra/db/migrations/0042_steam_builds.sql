-- Phase 8.8b — build identity from the Steam PICS product-info stream.
--
-- WHAT THIS ADDS THAT 0041 CANNOT. `steam_app_updates` holds ANNOUNCEMENTS: a
-- developer said a patch shipped. That is a claim with a timestamp. A buildid is
-- the identity of the bits the player actually ran. For a benchmarking project
-- the difference is "something changed around then" versus "these two runs are
-- on builds 25000182 and 25089218 and are not comparable".
--
-- This data is NOT in the Steam Web API. It comes from PICS over the Steam
-- network (anonymous login is sufficient for public appinfo), which is why it
-- has its own collector rather than living in the 8.7 Worker.
--
-- STRINGS, NOT NUMBERS. PICS returns every scalar as a string, and manifest
-- gids are 19 digits — `6967806384656644903` exceeds Number.MAX_SAFE_INTEGER,
-- so a gid that passes through a JS number is silently corrupted. Gids are text
-- here forever; sizes and buildids are bigint and must be cast by Postgres from
-- the string, never by the collector.

/*
 * One row per (branch, buildid) a branch has ever pointed at. That IS the build
 * history: re-observing an unchanged branch collides on the primary key and only
 * advances `last_seen_at`, while a patch introduces a new row.
 *
 * `time_updated` is when the BRANCH moved to this build — the moment the patch
 * reached players, and the column a before/after comparison joins on.
 * `time_build_updated` is when the build itself was produced, which is usually
 * earlier and is not the same event.
 */
create table if not exists steam_app_builds (
  appid              bigint not null references steam_apps (appid) on delete cascade,
  branch             text not null,
  buildid            bigint not null,
  time_updated       timestamptz,
  time_build_updated timestamptz,
  -- Valve's own label for a non-public branch ("Legacy Version of CS:GO").
  description        text,
  -- The PICS changenumber this was observed at; provenance, not identity.
  changenumber       bigint,
  first_seen_at      timestamptz not null,
  last_seen_at       timestamptz not null,
  primary key (appid, branch, buildid)
);

-- "What did this app's public branch look like around time T" — the join a
-- before/after delta needs.
create index if not exists steam_app_builds_appid_time_idx
  on steam_app_builds (appid, branch, time_updated desc);

create table if not exists steam_app_depots (
  appid        bigint not null references steam_apps (appid) on delete cascade,
  depot_id     bigint not null,
  -- Absent for system-defined depots, so nullable rather than defaulted.
  name         text,
  max_size     bigint,
  config_oslist text,
  first_seen_at timestamptz not null,
  last_seen_at timestamptz not null,
  primary key (appid, depot_id)
);

/*
 * Depot content history. A manifest gid identifies an exact set of files, so a
 * new gid on a (depot, branch) means the content changed — this is the
 * depot/manifest change history, at the granularity Steam actually publishes.
 *
 * Keying on the gid makes it self-deduplicating: an unchanged depot re-observed
 * every hour writes nothing but a `last_seen_at` bump.
 *
 * This is the table that would later make engine detection possible, since that
 * is inferred from depot FILE LISTS. Downloading manifests to read those lists
 * is a much heavier operation and is deliberately NOT part of this phase.
 */
create table if not exists steam_app_depot_manifests (
  appid          bigint not null references steam_apps (appid) on delete cascade,
  depot_id       bigint not null,
  branch         text not null,
  -- TEXT, permanently. A 19-digit gid does not survive a JS number.
  manifest_gid   text not null
                 constraint steam_app_depot_manifests_gid_check
                 check (manifest_gid ~ '^[0-9]{1,20}$'),
  size_bytes     bigint,
  download_bytes bigint,
  first_seen_at  timestamptz not null,
  last_seen_at   timestamptz not null,
  primary key (appid, depot_id, branch, manifest_gid)
);

create index if not exists steam_app_depot_manifests_appid_seen_idx
  on steam_app_depot_manifests (appid, first_seen_at desc);

/*
 * Where the changelist reader left off.
 *
 * Singleton by construction. The collector does NOT depend on this for
 * correctness — measured behaviour is that asking for changes since a
 * changenumber more than a few thousand behind returns an EMPTY app list with
 * no error and no `forceFullUpdate` flag, so a collector that trusted the
 * changelist alone would silently stop noticing patches. The periodic full
 * refresh of tracked apps is the source of truth; this cursor only lets a run
 * prioritise apps known to have changed.
 */
create table if not exists steam_pics_cursor (
  id           boolean primary key default true
               constraint steam_pics_cursor_singleton check (id),
  changenumber bigint not null,
  updated_at   timestamptz not null
);
