import { neon } from "@neondatabase/serverless";
import { normalizeAliasName, slugifyGameName } from "@heimdall/shared";

import type { CurationBatch, PersistReport } from "./types";

const LEGACY_REQUIRED_DRIVER_SOURCE =
  "repo://infra/db/migrations/0012_seed_required_drivers.sql";

/** Compare two dotted driver versions as numbers, ignoring trailing `.0` groups. */
const versionArraySql = (expression: string) =>
  `string_to_array(regexp_replace(${expression}, '([.]0)+$', ''), '.')::numeric[]`;

/**
 * Whether an incoming requirement replaces the stored one outright.
 *
 * `min_version` is the OLDEST driver known to support a title, so only an
 * EARLIER release supersedes it — the mirror of the catalog's newest-wins rule.
 * Vendors re-list already-supported titles for months (NVIDIA's "best gaming
 * experience for games including …" prose re-names flagship titles long after
 * their Game Ready release); adopting the newer mention would ratchet the
 * requirement up to whatever driver shipped that week and tell a user who
 * captured on the title's actual Game Ready driver that theirs is too old.
 *
 * A re-listing still refreshes `fetched_at` at the upsert — it is proof the
 * requirement is current, and `readRunForVerification` drops requirements that
 * fall outside their soak window.
 */
const REQUIREMENT_SUPERSEDES_SQL = `(
       -- Migration 0012 recorded when its synthetic seed was reviewed, not the
       -- vendor's driver release date. Let the first verified source replace that
       -- provenance even when its real release date is older.
       (
         game_driver_requirements.source_url = '${LEGACY_REQUIRED_DRIVER_SOURCE}'
         and excluded.source_url <> game_driver_requirements.source_url
         and excluded.fetched_at >= game_driver_requirements.fetched_at
       )
       or excluded.released_at < game_driver_requirements.released_at
       or (
         excluded.released_at = game_driver_requirements.released_at
         and ${versionArraySql("excluded.min_version")}
           < ${versionArraySql("game_driver_requirements.min_version")}
       )
     )`;

/**
 * One HTTP query performs both idempotent upserts. Game-ready titles resolve
 * only through existing canonical rows/aliases. Exact slugs win; conservative
 * token-overlap matches require a unique best candidate with a safety margin.
 */
export const CURATION_UPSERT_SQL = `with catalog_input as (
  select *
    from jsonb_to_recordset($1::jsonb) as x(
      vendor text,
      os text,
      component text,
      gpu_series text,
      latest_version text,
      released_at date,
      source_url text,
      fetched_at timestamptz
    )
), catalog_upsert as (
  insert into driver_catalog (
    vendor, os, component, gpu_series, latest_version,
    released_at, source_url, fetched_at
  )
  select vendor, os, component, nullif(gpu_series, ''), latest_version,
         released_at, source_url, fetched_at
    from catalog_input
  on conflict (vendor, os, component, gpu_series_key) do update
    set gpu_series = excluded.gpu_series,
        latest_version = excluded.latest_version,
        released_at = excluded.released_at,
        source_url = excluded.source_url,
        fetched_at = excluded.fetched_at
  where excluded.released_at > driver_catalog.released_at
     or (
       excluded.released_at = driver_catalog.released_at
       and (
          -- Source parsing admits only numeric dot-separated versions; arrays
          -- compare those segments numerically rather than lexically.
          string_to_array(regexp_replace(excluded.latest_version, '([.]0)+$', ''), '.')::numeric[]
            > string_to_array(
              regexp_replace(driver_catalog.latest_version, '([.]0)+$', ''),
              '.'
            )::numeric[]
          or (
            string_to_array(regexp_replace(excluded.latest_version, '([.]0)+$', ''), '.')::numeric[]
              = string_to_array(
                regexp_replace(driver_catalog.latest_version, '([.]0)+$', ''),
                '.'
              )::numeric[]
            and (
              excluded.fetched_at > driver_catalog.fetched_at
              or (
                excluded.fetched_at = driver_catalog.fetched_at
                and (
                  excluded.gpu_series,
                  excluded.latest_version,
                  excluded.source_url
                ) is distinct from (
                  driver_catalog.gpu_series,
                  driver_catalog.latest_version,
                  driver_catalog.source_url
                )
              )
            )
          )
        )
      )
  returning 1
), requirement_input as (
  select *
    from jsonb_to_recordset($2::jsonb) as x(
      ordinal integer,
      vendor text,
      os text,
      min_version text,
      title text,
      normalized_name text,
      slug text,
      released_at date,
      source_url text,
      fetched_at timestamptz
    )
), requirement_names as (
  select requirement_input.*,
         regexp_split_to_array(normalized_name, '\\s+') as tokens
    from requirement_input
), requirement_probes as (
  -- A score of 0.82 permits at most floor(18% of input tokens) to differ.
  -- Probe with one more of the longest distinct tokens than that allowance:
  -- every candidate that can pass the exact overlap test below must share one.
  -- The GIN indexes in 0024 make this a narrow candidate lookup rather than a
  -- cross join over every canonical game name and alias.
  select i.*,
         array(
           select token
             from (
               select distinct token
                 from unnest(i.tokens) as input_token(token)
             ) distinct_tokens
            order by char_length(token) desc, token
            limit greatest(1, floor(cardinality(i.tokens) * 0.18)::integer + 1)
         ) as probe_tokens
    from requirement_names i
), exact_raw_candidates as (
  select i.ordinal, g.id as game_id, 3 as priority, 1::real as score
    from requirement_probes i
    join games g on g.slug = i.slug
  union all
  select i.ordinal, ga.game_id, 2 as priority, 1::real as score
    from requirement_probes i
    join game_aliases ga on ga.normalized_name = i.normalized_name
), exact_candidates as (
  select ordinal, game_id, max(priority) as priority, max(score) as score
    from exact_raw_candidates
   group by ordinal, game_id
), unresolved_requirements as (
  select i.*
    from requirement_probes i
   where not exists (
     select 1 from exact_candidates exact where exact.ordinal = i.ordinal
   )
), fuzzy_candidates as (
  select i.ordinal,
         n.game_id,
         1 as priority,
         max(token_overlap.score) as score
    from unresolved_requirements i
   cross join lateral (
     select g.id as game_id,
            lower(g.name) as normalized_name,
            regexp_split_to_array(lower(g.name), '\\s+') as tokens
       from games g
      where regexp_split_to_array(lower(g.name), '\\s+') && i.probe_tokens
     union all
     select ga.game_id,
            ga.normalized_name,
            regexp_split_to_array(ga.normalized_name, '\\s+') as tokens
       from game_aliases ga
      where regexp_split_to_array(ga.normalized_name, '\\s+') && i.probe_tokens
   ) n
   cross join lateral (
     select count(*)::real /
            greatest(cardinality(i.tokens), cardinality(n.tokens), 1) as score
       from (
         select unnest(i.tokens) as token
         intersect
         select unnest(n.tokens) as token
       ) shared_tokens
   ) token_overlap
   where token_overlap.score >= 0.82
   group by i.ordinal, n.game_id
), raw_candidates as (
  select * from exact_candidates
  union all
  select * from fuzzy_candidates
), ranked_candidates as (
  select raw_candidates.*,
         row_number() over (
           partition by ordinal order by priority desc, score desc, game_id
         ) as candidate_rank,
         lead(priority) over (
           partition by ordinal order by priority desc, score desc, game_id
         ) as next_priority,
         lead(score) over (
           partition by ordinal order by priority desc, score desc, game_id
         ) as next_score
    from raw_candidates
), resolved as (
  select i.*, ranked.game_id
    from requirement_probes i
    join ranked_candidates ranked on ranked.ordinal = i.ordinal
   where ranked.candidate_rank = 1
     and (
       ranked.priority = 3
       or ranked.next_priority is null
       or ranked.priority > ranked.next_priority
       or ranked.score - ranked.next_score >= 0.08
     )
), requirement_upsert as (
  insert into game_driver_requirements (
    game_id, vendor, os, min_version, source_url, released_at, fetched_at
  )
  select game_id, vendor, os, min_version, source_url, released_at, fetched_at
    from (
      select deduplicated.*
        from (
           select resolved.*,
                  -- Two probe titles can resolve to one game (a truncated list
                  -- fragment alongside the full title). Earliest wins, matching
                  -- REQUIREMENT_SUPERSEDES_SQL — min_version is the oldest driver
                  -- known to support the game, not the newest that named it.
                  row_number() over (
                    partition by game_id, vendor, os
                    order by released_at asc,
                             ${versionArraySql("min_version")} asc,
                             fetched_at desc,
                             ordinal
                  ) as target_rank
             from resolved
        ) deduplicated
       where deduplicated.target_rank = 1
    ) resolved_targets
  on conflict (game_id, vendor, os) do update
    set min_version = case when ${REQUIREMENT_SUPERSEDES_SQL}
          then excluded.min_version else game_driver_requirements.min_version end,
        source_url = case when ${REQUIREMENT_SUPERSEDES_SQL}
          then excluded.source_url else game_driver_requirements.source_url end,
        released_at = case when ${REQUIREMENT_SUPERSEDES_SQL}
          then excluded.released_at else game_driver_requirements.released_at end,
        -- Always advance: a later release re-listing the title does not change
        -- what the minimum is, but it does prove the requirement is still live,
        -- and a stale fetched_at drops it out of its soak window entirely.
        fetched_at = greatest(excluded.fetched_at, game_driver_requirements.fetched_at)
  where ${REQUIREMENT_SUPERSEDES_SQL}
     or excluded.fetched_at > game_driver_requirements.fetched_at
  returning 1
)
select (select count(*)::integer from catalog_upsert) as catalog_upserted,
       (select count(*)::integer from requirement_upsert) as requirements_upserted,
       (select count(*)::integer from requirement_input) as requirements_received,
       (select count(*)::integer from resolved) as requirements_matched,
       coalesce(
         (
           select jsonb_agg(i.title order by i.ordinal)
             from requirement_input i
             left join resolved r on r.ordinal = i.ordinal
            where r.ordinal is null
         ),
         '[]'::jsonb
       ) as unmatched_titles`;

interface PersistRow {
  catalog_upserted: number;
  requirements_upserted: number;
  requirements_received: number;
  requirements_matched: number;
  unmatched_titles: string[];
}

export type SqlExecutor = (text: string, params: readonly unknown[]) => Promise<PersistRow[]>;

function validateDatabaseUrl(value: string): void {
  const url = new URL(value);
  if (!(["postgres:", "postgresql:"] as string[]).includes(url.protocol) || !url.hostname) {
    throw new Error("DATABASE_URL must be a PostgreSQL connection string");
  }
}

function catalogJson(batch: CurationBatch): string {
  return JSON.stringify(
    batch.catalog.map((row) => ({
      vendor: row.vendor,
      os: row.os,
      component: row.component,
      gpu_series: row.gpuSeries ?? null,
      latest_version: row.latestVersion,
      released_at: row.releasedAt,
      source_url: row.sourceUrl,
      fetched_at: row.fetchedAt,
    })),
  );
}

function requirementsJson(batch: CurationBatch): string {
  return JSON.stringify(
    batch.requirements.map((row, ordinal) => ({
      ordinal,
      vendor: row.vendor,
      os: row.os,
      min_version: row.minVersion,
      title: row.title,
      normalized_name: normalizeAliasName(row.title),
      slug: slugifyGameName(row.title),
      released_at: row.releasedAt,
      source_url: row.sourceUrl,
      fetched_at: row.fetchedAt,
    })),
  );
}

export async function persistCurationWith(
  execute: SqlExecutor,
  batch: CurationBatch,
): Promise<PersistReport> {
  const rows = await execute(CURATION_UPSERT_SQL, [catalogJson(batch), requirementsJson(batch)]);
  const row = rows[0];
  if (!row) throw new Error("curation upsert returned no report");
  return {
    catalogUpserted: Number(row.catalog_upserted),
    requirementsUpserted: Number(row.requirements_upserted),
    requirementsReceived: Number(row.requirements_received),
    requirementsMatched: Number(row.requirements_matched),
    unmatchedTitles: Array.isArray(row.unmatched_titles) ? row.unmatched_titles : [],
  };
}

export async function persistCuration(
  databaseUrl: string,
  batch: CurationBatch,
): Promise<PersistReport> {
  validateDatabaseUrl(databaseUrl);
  const sql = neon(databaseUrl);
  return persistCurationWith(
    (text, params) => sql.query(text, params as never[]) as unknown as Promise<PersistRow[]>,
    batch,
  );
}
