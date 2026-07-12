/**
 * Canonical-id resolution on finalize (§11.9 / §4.4): match-or-create the game
 * (alias-aware) and map GPU/CPU display strings to canonical hardware rows.
 *
 * Race-safe by construction: creates use `on conflict do nothing` + re-select,
 * leaning on the unique keys from 0001/0004 (games.slug, game_aliases,
 * hardware_aliases (source, normalized_name, kind), hardware (kind,
 * lower(canonical_name))). Callers treat failures as non-fatal — a run always
 * keeps its raw strings; canonical ids are enrichment, not a gate.
 */

import { cleanDisplayName, normalizeAliasName, slugifyGameName } from "@heimdall/shared";
import { query, getPool, type Queryable } from "../db";

/**
 * The alias-lookup → canonical-lookup → insert-on-conflict → re-select →
 * record-alias state machine, shared by games and hardware so a fix to the
 * race-recovery or alias-recording logic can never drift between the two.
 * Alias reads prefer the exact capture source but fall back to another source
 * in one indexed query; every step returns ids as bigint-as-string.
 */
async function matchOrCreate(steps: {
  findAlias(): Promise<{ id: string; exactSource: boolean } | undefined>;
  findCanonical(): Promise<string | undefined>;
  insertCanonical(): Promise<string | undefined>;
  recordAlias(id: string): Promise<void>;
}): Promise<string | null> {
  const aliasHit = await steps.findAlias();
  if (aliasHit) {
    // Avoid a no-op upsert for the normal repeated-capture path. A hit from a
    // different source records this spelling once, then becomes exact too.
    if (!aliasHit.exactSource) {
      await steps.recordAlias(aliasHit.id);
    }
    return aliasHit.id;
  }

  const id =
    (await steps.findCanonical()) ??
    (await steps.insertCanonical()) ??
    // Lost the create race — the winner's row is what we want.
    (await steps.findCanonical());
  if (!id) {
    return null;
  }

  await steps.recordAlias(id);
  return id;
}

const firstId = (rows: { id: string }[]) => rows[0]?.id;

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
  // Symbol-only names all collapse to slugifyGameName's "untitled" sentinel;
  // matching or creating by that shared slug would merge distinct games
  // permanently (and poison the alias table). No letters/digits → no
  // canonical identity; the run keeps its raw string.
  if (!/[\p{L}\p{N}]/u.test(normalized)) {
    return null;
  }
  const slug = slugifyGameName(rawName);

  return matchOrCreate({
    findAlias: async () => {
      const row = (await query<{ game_id: string; exact_source: boolean }>(
        `select game_id, source = $1 as exact_source
           from game_aliases
          where normalized_name = $2
          order by (source = $1) desc
          limit 1`,
        [source, normalized],
        db,
      ))[0];
      return row ? { id: row.game_id, exactSource: row.exact_source } : undefined;
    },
    findCanonical: async () =>
      firstId(
        await query<{ id: string }>(
          "select id from games where slug = $1 or lower(name) = $2 limit 1",
          [slug, normalized],
          db,
        ),
      ),
    insertCanonical: async () =>
      firstId(
        await query<{ id: string }>(
          "insert into games (slug, name) values ($1, $2) on conflict (slug) do nothing returning id",
          [slug, cleanDisplayName(rawName)],
          db,
        ),
      ),
    recordAlias: async (gameId) => {
      await db.query(
        `insert into game_aliases (game_id, source, raw_name, normalized_name)
         values ($1, $2, $3, $4)
         on conflict (source, normalized_name) do nothing`,
        [gameId, source, rawName, normalized],
      );
    },
  });
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

  // `cleanDisplayName` lowercases to exactly `normalized`, so the 0004 unique
  // index on (kind, lower(canonical_name)) is both the lookup key and the
  // create-race arbiter.
  const findCanonical = async () =>
    firstId(
      await query<{ id: string }>(
        "select id from hardware where kind = $1 and lower(canonical_name) = $2 limit 1",
        [kind, normalized],
        db,
      ),
    );

  return matchOrCreate({
    findAlias: async () => {
      const row = (await query<{ hardware_id: string; exact_source: boolean }>(
        `select ha.hardware_id, ha.source = $1 as exact_source
             from hardware_aliases ha
             join hardware h on h.id = ha.hardware_id and h.kind = ha.kind
            where ha.normalized_name = $2 and ha.kind = $3
            order by (ha.source = $1) desc
            limit 1`,
        [source, normalized, kind],
        db,
      ))[0];
      return row ? { id: row.hardware_id, exactSource: row.exact_source } : undefined;
    },
    findCanonical,
    insertCanonical: async () =>
      firstId(
        await query<{ id: string }>(
          `insert into hardware (kind, vendor, canonical_name)
           values ($1, $2, $3)
           on conflict (kind, lower(canonical_name)) do nothing
           returning id`,
          [kind, vendor, cleanDisplayName(rawName)],
          db,
        ),
      ),
    recordAlias: async (hardwareId) => {
      await db.query(
        `insert into hardware_aliases (hardware_id, kind, source, raw_name, normalized_name)
         values ($1, $2, $3, $4, $5)
         on conflict (source, normalized_name, kind) do nothing`,
        [hardwareId, kind, source, rawName, normalized],
      );
    },
  });
}
