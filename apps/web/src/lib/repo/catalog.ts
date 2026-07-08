/**
 * Canonical-id resolution on finalize (§11.9 / §4.4): match-or-create the game
 * (alias-aware) and map GPU/CPU display strings to canonical hardware rows.
 *
 * Race-safe by construction: creates use `on conflict do nothing` + re-select,
 * leaning on the unique keys from 0001/0004 (games.slug, game_aliases /
 * hardware_aliases (source, normalized_name), hardware (kind,
 * lower(canonical_name))). Callers treat failures as non-fatal — a run always
 * keeps its raw strings; canonical ids are enrichment, not a gate.
 */

import { cleanDisplayName, normalizeAliasName, slugifyGameName } from "@heimdall/shared";
import { query, getPool, type Queryable } from "../db";

/** Canonical game id (bigint as string), creating game + alias as needed. */
export async function resolveGameId(
  source: string,
  rawName: string,
  db: Queryable = getPool(),
): Promise<string | null> {
  const normalized = normalizeAliasName(rawName);
  if (!normalized) {
    return null;
  }

  const viaAlias = await query<{ game_id: string }>(
    "select game_id from game_aliases where normalized_name = $1 limit 1",
    [normalized],
    db,
  );
  const aliasHit = viaAlias[0]?.game_id;
  if (aliasHit) {
    await recordGameAlias(aliasHit, source, rawName, normalized, db);
    return aliasHit;
  }

  const slug = slugifyGameName(rawName);
  let gameId = (
    await query<{ id: string }>(
      "select id from games where slug = $1 or lower(name) = $2 limit 1",
      [slug, normalized],
      db,
    )
  )[0]?.id;

  if (!gameId) {
    const inserted = await query<{ id: string }>(
      "insert into games (slug, name) values ($1, $2) on conflict (slug) do nothing returning id",
      [slug, cleanDisplayName(rawName)],
      db,
    );
    gameId =
      inserted[0]?.id ??
      // Lost the create race — the winner's row is what we want.
      (await query<{ id: string }>("select id from games where slug = $1", [slug], db))[0]?.id;
  }
  if (!gameId) {
    return null;
  }

  await recordGameAlias(gameId, source, rawName, normalized, db);
  return gameId;
}

async function recordGameAlias(
  gameId: string,
  source: string,
  rawName: string,
  normalized: string,
  db: Queryable,
): Promise<void> {
  await db.query(
    `insert into game_aliases (game_id, source, raw_name, normalized_name)
     values ($1, $2, $3, $4)
     on conflict (source, normalized_name) do nothing`,
    [gameId, source, rawName, normalized],
  );
}

/** Canonical hardware id (bigint as string) for a GPU/CPU display string. */
export async function resolveHardwareId(
  kind: "gpu" | "cpu",
  source: string,
  rawName: string,
  vendor: string | null,
  db: Queryable = getPool(),
): Promise<string | null> {
  const normalized = normalizeAliasName(rawName);
  if (!normalized) {
    return null;
  }

  const viaAlias = await query<{ hardware_id: string }>(
    `select ha.hardware_id
       from hardware_aliases ha
       join hardware h on h.id = ha.hardware_id
      where ha.normalized_name = $1 and h.kind = $2
      limit 1`,
    [normalized, kind],
    db,
  );
  const aliasHit = viaAlias[0]?.hardware_id;
  if (aliasHit) {
    await recordHardwareAlias(aliasHit, source, rawName, normalized, db);
    return aliasHit;
  }

  // `cleanDisplayName` lowercases to exactly `normalized`, so the 0004 unique
  // index on (kind, lower(canonical_name)) is both the lookup key and the
  // create-race arbiter.
  let hardwareId = (
    await query<{ id: string }>(
      "select id from hardware where kind = $1 and lower(canonical_name) = $2 limit 1",
      [kind, normalized],
      db,
    )
  )[0]?.id;

  if (!hardwareId) {
    const inserted = await query<{ id: string }>(
      `insert into hardware (kind, vendor, canonical_name)
       values ($1, $2, $3)
       on conflict (kind, lower(canonical_name)) do nothing
       returning id`,
      [kind, vendor, cleanDisplayName(rawName)],
      db,
    );
    hardwareId =
      inserted[0]?.id ??
      (
        await query<{ id: string }>(
          "select id from hardware where kind = $1 and lower(canonical_name) = $2 limit 1",
          [kind, normalized],
          db,
        )
      )[0]?.id;
  }
  if (!hardwareId) {
    return null;
  }

  await recordHardwareAlias(hardwareId, source, rawName, normalized, db);
  return hardwareId;
}

async function recordHardwareAlias(
  hardwareId: string,
  source: string,
  rawName: string,
  normalized: string,
  db: Queryable,
): Promise<void> {
  await db.query(
    `insert into hardware_aliases (hardware_id, source, raw_name, normalized_name)
     values ($1, $2, $3, $4)
     on conflict (source, normalized_name) do nothing`,
    [hardwareId, source, rawName, normalized],
  );
}
