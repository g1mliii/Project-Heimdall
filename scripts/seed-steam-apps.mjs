/**
 * Seed the Phase 8.7 Steam ingest working set.
 *
 * The scheduled worker's fast lanes (players every 10 minutes, reviews hourly,
 * prices 4x daily) read their working set from `steam_apps`. On a fresh
 * database that table is empty, so those lanes poll nothing until the DAILY
 * catalog lane runs discovery — up to 24 hours of collecting no history at all.
 * This closes that gap at deploy time.
 *
 * Two sources, both keyless:
 *   1. store featuredcategories — whatever is currently selling and trending.
 *   2. A curated appid list of titles people actually benchmark, which the
 *      trending feed will not surface on a quiet day.
 *
 * NAMES ARE NEVER HARDCODED. Every appid is resolved against the store and
 * skipped unless it comes back as a real `game`, so a mistyped id seeds nothing
 * rather than silently labelling the wrong title. The run prints what it
 * resolved so the result is auditable.
 *
 * Re-running is safe: the upsert never widens a hand-narrowed poll_tier, and
 * the daily catalog lane enriches these rows with metadata, tags and news.
 *
 *   DATABASE_URL=postgres://... node scripts/seed-steam-apps.mjs
 */

import pg from "pg";

const STORE = "https://store.steampowered.com";
const USER_AGENT = "HeimdallSteamIngest/1.0 (+https://github.com/g1mliii/Project-Heimdall)";

/** Titles that get benchmarked, which a trending feed alone would miss. */
const CURATED_APPIDS = [
  730, 570, 440, 578080, 1172470, 553850, 359550, 252490, 381210, 1085660,
  1091500, 1245620, 292030, 271590, 1174180, 1086940, 1593500, 1817070,
  2358720, 990080, 2050650, 275850, 105600, 413150, 1145360, 227300, 236390,
];

/** Featured entries are tier 1; the curated spine is tier 1 too. */
const POLL_TIER = 1;
const REQUEST_GAP_MS = 250;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function getJson(url) {
  const response = await fetch(url, { headers: { accept: "application/json", "user-agent": USER_AGENT } });
  if (!response.ok) throw new Error(`HTTP ${response.status} for ${new URL(url).pathname}`);
  return response.json();
}

async function fromFeatured() {
  const body = await getJson(`${STORE}/api/featuredcategories?cc=us&l=en`);
  const found = new Map();
  for (const category of Object.values(body ?? {})) {
    if (!category || typeof category !== "object" || !Array.isArray(category.items)) continue;
    for (const item of category.items) {
      if (!item || typeof item.id !== "number" || typeof item.name !== "string") continue;
      if (!found.has(item.id)) found.set(item.id, item.name.trim());
    }
  }
  return found;
}

async function resolveCurated(known) {
  const resolved = new Map();
  for (const appid of CURATED_APPIDS) {
    if (known.has(appid)) continue;
    try {
      const body = await getJson(`${STORE}/api/appdetails?appids=${appid}&cc=us&l=en&filters=basic`);
      const entry = body?.[String(appid)];
      const data = entry?.success === true ? entry.data : undefined;
      // Only a real game earns a row — a bad id seeds nothing.
      if (!data || typeof data.name !== "string" || (data.type && data.type !== "game")) {
        console.warn(`  skip ${appid}: not a game (${data?.type ?? "no data"})`);
        continue;
      }
      resolved.set(appid, data.name.trim());
    } catch (error) {
      console.warn(`  skip ${appid}: ${error.message}`);
    }
    await sleep(REQUEST_GAP_MS);
  }
  return resolved;
}

async function main() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL is required");

  console.log("discovering from store featuredcategories...");
  const featured = await fromFeatured();
  console.log(`  ${featured.size} appids from the featured feed`);

  console.log("resolving the curated benchmark list against the store...");
  const curated = await resolveCurated(featured);
  console.log(`  ${curated.size} additional appids resolved`);

  const rows = [
    ...[...featured].map(([appid, name]) => ({ appid, name, reason: "featured" })),
    ...[...curated].map(([appid, name]) => ({ appid, name, reason: "curated-benchmark" })),
  ];
  if (rows.length === 0) throw new Error("no apps resolved — refusing to seed nothing");

  const pool = new pg.Pool({ connectionString: databaseUrl, max: 1 });
  try {
    const { rows: written } = await pool.query(
      `insert into steam_apps (appid, name, poll_tier, tracking_reason)
       select appid, name, poll_tier, tracking_reason
         from jsonb_to_recordset($1::jsonb) as x(
           appid bigint, name text, poll_tier smallint, tracking_reason text
         )
       on conflict (appid) do update
         set name = excluded.name,
             poll_tier = least(steam_apps.poll_tier, excluded.poll_tier),
             tracking_reason = coalesce(steam_apps.tracking_reason, excluded.tracking_reason)
       returning appid`,
      [JSON.stringify(rows.map((r) => ({ ...r, poll_tier: POLL_TIER, tracking_reason: r.reason })))],
    );
    const { rows: total } = await pool.query(
      `select count(*)::int as tracked from steam_apps where poll_tier > 0`,
    );
    console.log(`\nupserted ${written.length} rows; ${total[0].tracked} apps now tracked`);
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error(`seed failed: ${error.message}`);
  process.exitCode = 1;
});
