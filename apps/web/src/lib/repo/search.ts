/**
 * Public catalog search (§17.6).
 *
 * One statement returns both result kinds. Each name/alias source is ordered
 * and bounded before unioning, then canonical ids are grouped at their best
 * score so one title cannot appear twice. Games sort ahead of hardware because
 * only games have a destination in Phase 7.0.
 *
 * The indexable pg_trgm `%` operator reads the session's
 * `pg_trgm.similarity_threshold`; production and tests deliberately keep its
 * default at 0.3 and pair it with an explicit `similarity >= $3` floor. Never
 * call `set_limit()` or issue a bare `SET` on the app pool: either would leak a
 * session setting into an unrelated request. A future non-default threshold
 * must use `SET LOCAL` inside a checked-out transaction.
 */

import {
  MAX_INDEXED_METADATA_TEXT_LENGTH,
  SEARCH_MIN_QUERY_LENGTH,
  SEARCH_RESULT_LIMIT,
  SEARCH_SIMILARITY_THRESHOLD,
  normalizeAliasName,
  slugifyGameName,
} from "@heimdall/shared";
import type { SearchResponse } from "@heimdall/shared";

import { getPool, query, type Queryable } from "../db";

const CANDIDATE_LIMIT = 25;

interface SearchRow {
  kind: "game" | "hardware";
  id: string;
  slug: string | null;
  name: string;
  hardware_kind: "gpu" | "cpu" | null;
  vendor: string | null;
}

export const SEARCH_CATALOG_SQL = `with game_candidates as (
  (
    select g.id, g.slug, g.name, similarity(g.name, $1) as score
      from games g
     where g.name % $1
       and similarity(g.name, $1) >= $3
     order by score desc, g.name, g.id
     limit $6
  )
  union all
  (
    select g.id, g.slug, g.name, similarity(g.slug, $2) as score
      from games g
     where g.slug % $2
       and similarity(g.slug, $2) >= $3
     order by score desc, g.name, g.id
     limit $6
  )
  union all
  (
    select g.id, g.slug, g.name, similarity(ga.normalized_name, $1) as score
      from game_aliases ga
      join games g on g.id = ga.game_id
     where ga.normalized_name % $1
       and similarity(ga.normalized_name, $1) >= $3
     order by score desc, g.name, g.id
     limit $6
  )
), game_hits as (
  select id, slug, name, max(score) as score
    from game_candidates
   group by id, slug, name
   order by score desc, name, id
   limit $4
), hardware_candidates as (
  (
    select h.id, h.kind, h.vendor, h.canonical_name,
           similarity(h.canonical_name, $1) as score
      from hardware h
     where h.canonical_name % $1
       and similarity(h.canonical_name, $1) >= $3
     order by score desc, h.canonical_name, h.id
     limit $6
  )
  union all
  (
    select h.id, h.kind, h.vendor, h.canonical_name,
           similarity(ha.normalized_name, $1) as score
      from hardware_aliases ha
      join hardware h on h.id = ha.hardware_id and h.kind = ha.kind
     where ha.normalized_name % $1
       and similarity(ha.normalized_name, $1) >= $3
     order by score desc, h.canonical_name, h.id
     limit $6
  )
), hardware_hits as (
  select id, kind, vendor, canonical_name, max(score) as score
    from hardware_candidates
   group by id, kind, vendor, canonical_name
   order by score desc, canonical_name, id
   limit $5
), hits as (
  select 'game'::text as kind, id, slug, name, null::text as hardware_kind,
         null::text as vendor, score
    from game_hits
  union all
  select 'hardware'::text as kind, id, null::text as slug,
         canonical_name as name, kind as hardware_kind, vendor, score
    from hardware_hits
)
select kind, id::text, slug, name, hardware_kind, vendor
  from hits
 order by (kind <> 'game'), score desc, name, id`;

const EMPTY_SEARCH: SearchResponse = { games: [], hardware: [] };

/**
 * The single min/max gate for catalog search: the normalized query when it can
 * produce results, else `null`. Both the route (to skip a rate-limit token on a
 * too-short typeahead) and `searchCatalog` (its own guard) call this so the
 * bound is defined once and always measured against the same normalized string.
 */
export function normalizeSearchQuery(rawQuery: string): string | null {
  const normalized = normalizeAliasName(rawQuery);
  if (
    normalized.length < SEARCH_MIN_QUERY_LENGTH ||
    normalized.length > MAX_INDEXED_METADATA_TEXT_LENGTH
  ) {
    return null;
  }
  return normalized;
}

export async function searchCatalog(
  rawQuery: string,
  db: Queryable = getPool(),
): Promise<SearchResponse> {
  const normalized = normalizeSearchQuery(rawQuery);
  if (normalized === null) {
    return EMPTY_SEARCH;
  }

  const rows = await query<SearchRow>(
    SEARCH_CATALOG_SQL,
    [
      normalized,
      slugifyGameName(normalized),
      SEARCH_SIMILARITY_THRESHOLD,
      SEARCH_RESULT_LIMIT.games,
      SEARCH_RESULT_LIMIT.hardware,
      CANDIDATE_LIMIT,
    ],
    db,
  );

  const result: SearchResponse = { games: [], hardware: [] };
  for (const row of rows) {
    if (row.kind === "game" && row.slug) {
      result.games.push({ id: row.id, slug: row.slug, name: row.name });
    } else if (row.kind === "hardware" && row.hardware_kind) {
      result.hardware.push({
        id: row.id,
        kind: row.hardware_kind,
        vendor: row.vendor,
        canonicalName: row.name,
      });
    }
  }
  return result;
}
