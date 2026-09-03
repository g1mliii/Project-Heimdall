import { neon } from "@neondatabase/serverless";

import type { AppBuild, AppDepot, DepotManifest } from "./parse.js";

/**
 * Every statement binds ONE parameter — a jsonb array of the batch — matching
 * the steam-ingest worker's convention, so no `$n` offset is hand-counted.
 *
 * Decimal strings are cast to bigint by the `jsonb_to_recordset` column types
 * here, never by the collector. That is what keeps a 19-digit manifest gid
 * intact: it arrives as a string and lands in a text column, while buildids and
 * sizes arrive as strings and are widened by Postgres.
 */

export type SqlExecutor = <Row>(text: string, params: readonly unknown[]) => Promise<Row[]>;

/** Apps worth asking PICS about: the same working set 8.7 already polls. */
export const TRACKED_APPS_SQL = `select appid
  from steam_apps
 where poll_tier > 0
 order by poll_tier asc, appid asc`;

export const READ_CURSOR_SQL = `select changenumber from steam_pics_cursor where id = true`;

export const WRITE_CURSOR_SQL = `insert into steam_pics_cursor (id, changenumber, updated_at)
values (true, $1::bigint, now())
on conflict (id) do update
  -- Never move the cursor backwards: a stale run finishing late must not undo a
  -- newer one's progress.
  set changenumber = greatest(steam_pics_cursor.changenumber, excluded.changenumber),
      updated_at = now()
returning changenumber`;

export const UPSERT_BUILDS_SQL = `insert into steam_app_builds (
  appid, branch, buildid, time_updated, time_build_updated,
  description, changenumber, first_seen_at, last_seen_at
)
select x.appid, x.branch, x.buildid, x.time_updated, x.time_build_updated,
       x.description, x.changenumber, x.seen_at, x.seen_at
  from jsonb_to_recordset($1::jsonb) as x(
    appid bigint,
    branch text,
    buildid bigint,
    time_updated timestamptz,
    time_build_updated timestamptz,
    description text,
    changenumber bigint,
    seen_at timestamptz
  )
 where exists (select 1 from steam_apps a where a.appid = x.appid)
on conflict (appid, branch, buildid) do update
  -- A build already recorded is not news; only prove it is still current.
  set last_seen_at = greatest(steam_app_builds.last_seen_at, excluded.last_seen_at),
      time_updated = coalesce(steam_app_builds.time_updated, excluded.time_updated),
      changenumber = greatest(
        coalesce(steam_app_builds.changenumber, 0), coalesce(excluded.changenumber, 0)
      )
returning (xmax = 0) as inserted`;

export const UPSERT_DEPOTS_SQL = `insert into steam_app_depots (
  appid, depot_id, name, max_size, config_oslist, first_seen_at, last_seen_at
)
select x.appid, x.depot_id, x.name, x.max_size, x.config_oslist, x.seen_at, x.seen_at
  from jsonb_to_recordset($1::jsonb) as x(
    appid bigint,
    depot_id bigint,
    name text,
    max_size bigint,
    config_oslist text,
    seen_at timestamptz
  )
 where exists (select 1 from steam_apps a where a.appid = x.appid)
on conflict (appid, depot_id) do update
  set name = coalesce(excluded.name, steam_app_depots.name),
      max_size = coalesce(excluded.max_size, steam_app_depots.max_size),
      config_oslist = coalesce(excluded.config_oslist, steam_app_depots.config_oslist),
      last_seen_at = greatest(steam_app_depots.last_seen_at, excluded.last_seen_at)
returning (xmax = 0) as inserted`;

export const UPSERT_MANIFESTS_SQL = `insert into steam_app_depot_manifests (
  appid, depot_id, branch, manifest_gid, size_bytes, download_bytes,
  first_seen_at, last_seen_at
)
select x.appid, x.depot_id, x.branch, x.manifest_gid, x.size_bytes, x.download_bytes,
       x.seen_at, x.seen_at
  from jsonb_to_recordset($1::jsonb) as x(
    appid bigint,
    depot_id bigint,
    branch text,
    manifest_gid text,
    size_bytes bigint,
    download_bytes bigint,
    seen_at timestamptz
  )
 where exists (select 1 from steam_apps a where a.appid = x.appid)
on conflict (appid, depot_id, branch, manifest_gid) do update
  set last_seen_at = greatest(
        steam_app_depot_manifests.last_seen_at, excluded.last_seen_at
      )
returning (xmax = 0) as inserted`;

function validateDatabaseUrl(value: string): void {
  const url = new URL(value);
  if (!(["postgres:", "postgresql:"] as string[]).includes(url.protocol) || !url.hostname) {
    throw new Error("DATABASE_URL must be a PostgreSQL connection string");
  }
}

export function executorFor(databaseUrl: string): SqlExecutor {
  validateDatabaseUrl(databaseUrl);
  const sql = neon(databaseUrl);
  return (<Row>(text: string, params: readonly unknown[]) =>
    sql.query(text, params as never[]) as unknown as Promise<Row[]>) as SqlExecutor;
}

export interface WriteCounts {
  /** Rows that did not exist before — the actual new information. */
  inserted: number;
  /** Rows re-confirmed. High and steady is the healthy state. */
  refreshed: number;
}

/**
 * `xmax = 0` distinguishes an insert from an update in a single upsert, which
 * is the difference between "this app patched" and "nothing changed". Counting
 * only affected rows would report every run as busy.
 */
async function writeBatch(
  execute: SqlExecutor,
  statement: string,
  rows: readonly unknown[],
): Promise<WriteCounts> {
  if (rows.length === 0) return { inserted: 0, refreshed: 0 };
  const written = await execute<{ inserted: boolean }>(statement, [JSON.stringify(rows)]);
  const inserted = written.filter((row) => row.inserted).length;
  return { inserted, refreshed: written.length - inserted };
}

export async function readTrackedApps(execute: SqlExecutor): Promise<number[]> {
  const rows = await execute<{ appid: string | number }>(TRACKED_APPS_SQL, []);
  return rows.map((row) => Number(row.appid)).filter((appid) => Number.isSafeInteger(appid));
}

export async function readCursor(execute: SqlExecutor): Promise<number | null> {
  const rows = await execute<{ changenumber: string | number }>(READ_CURSOR_SQL, []);
  if (rows.length === 0) return null;
  const value = Number(rows[0]!.changenumber);
  return Number.isSafeInteger(value) ? value : null;
}

export async function writeCursor(execute: SqlExecutor, changenumber: number): Promise<void> {
  if (!Number.isSafeInteger(changenumber) || changenumber < 0) {
    throw new Error("changenumber must be a non-negative safe integer");
  }
  await execute(WRITE_CURSOR_SQL, [String(changenumber)]);
}

export function writeBuilds(
  execute: SqlExecutor,
  builds: readonly AppBuild[],
  seenAt: string,
): Promise<WriteCounts> {
  return writeBatch(
    execute,
    UPSERT_BUILDS_SQL,
    builds.map((build) => ({
      appid: build.appid,
      branch: build.branch,
      buildid: build.buildid,
      time_updated: build.timeUpdated,
      time_build_updated: build.timeBuildUpdated,
      description: build.description,
      changenumber: build.changenumber,
      seen_at: seenAt,
    })),
  );
}

export function writeDepots(
  execute: SqlExecutor,
  depots: readonly AppDepot[],
  seenAt: string,
): Promise<WriteCounts> {
  return writeBatch(
    execute,
    UPSERT_DEPOTS_SQL,
    depots.map((depot) => ({
      appid: depot.appid,
      depot_id: depot.depotId,
      name: depot.name,
      max_size: depot.maxSize,
      config_oslist: depot.configOslist,
      seen_at: seenAt,
    })),
  );
}

export function writeManifests(
  execute: SqlExecutor,
  manifests: readonly DepotManifest[],
  seenAt: string,
): Promise<WriteCounts> {
  return writeBatch(
    execute,
    UPSERT_MANIFESTS_SQL,
    manifests.map((manifest) => ({
      appid: manifest.appid,
      depot_id: manifest.depotId,
      branch: manifest.branch,
      manifest_gid: manifest.manifestGid,
      size_bytes: manifest.sizeBytes,
      download_bytes: manifest.downloadBytes,
      seen_at: seenAt,
    })),
  );
}
