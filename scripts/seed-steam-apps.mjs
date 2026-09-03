/**
 * Seed the Phase 8.7 Steam ingest working set.
 *
 * The scheduled worker's fast lanes (players every 10 minutes, reviews hourly,
 * prices 4x daily) read their working set from `steam_apps`. On a fresh
 * database that table is empty, so those lanes poll nothing until the DAILY
 * catalog lane runs discovery — up to 24 hours of collecting no history at all.
 * This closes that gap at deploy time.
 *
 * Three sources, all keyless, in priority order:
 *   1. The Steam charts — GetGamesByConcurrentPlayers (live CCU) and
 *      GetMostPlayedGames (weekly peak). This is the source that matters:
 *      it ranks what people PLAY, and its 100th entry still has >10k players.
 *   2. store featuredcategories — what the store is PROMOTING. Kept because it
 *      surfaces a release on day one, before it can chart, but at a lower tier:
 *      seeding from it alone produced ~40 apps with single-digit player counts.
 *   3. A curated appid list of titles people actually benchmark, which neither
 *      feed will surface on a quiet day.
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
const API = "https://api.steampowered.com";
const USER_AGENT = "HeimdallSteamIngest/1.0 (+https://github.com/g1mliii/Project-Heimdall)";

/** Titles that get benchmarked, which a trending feed alone would miss. */
const CURATED_APPIDS = [
  730, 570, 440, 578080, 1172470, 553850, 359550, 252490, 381210, 1085660,
  1091500, 1245620, 292030, 271590, 1174180, 1086940, 1593500, 1817070,
  2358720, 990080, 2050650, 275850, 105600, 413150, 1145360, 227300, 236390,
];

/** Charts and curated titles are tier 1; featured is tier 2. */
const REQUEST_GAP_MS = 250;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function getJson(url) {
  const response = await fetch(url, { headers: { accept: "application/json", "user-agent": USER_AGENT } });
  if (!response.ok) throw new Error(`HTTP ${response.status} for ${new URL(url).pathname}`);
  return response.json();
}

/** Appids only — the charts endpoints never return names. */
async function fromCharts() {
  const found = [];
  const seen = new Set();
  for (const path of [
    "ISteamChartsService/GetGamesByConcurrentPlayers/v1/",
    "ISteamChartsService/GetMostPlayedGames/v1/",
  ]) {
    try {
      const body = await getJson(`${API}/${path}`);
      for (const entry of body?.response?.ranks ?? []) {
        if (typeof entry?.appid !== "number" || seen.has(entry.appid)) continue;
        seen.add(entry.appid);
        found.push(entry.appid);
      }
    } catch (error) {
      console.warn(`  chart ${path} failed: ${error.message}`);
    }
  }
  return found;
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

async function resolveNames(appids, known) {
  const resolved = new Map();
  for (const appid of appids) {
    if (known.has(appid)) continue;
    try {
      const body = await getJson(`${STORE}/api/appdetails?appids=${appid}&cc=us&l=en&filters=basic`);
      const entry = body?.[String(appid)];
      const data = entry?.success === true ? entry.data : undefined;
      // Only a real game earns a row — a bad id seeds nothing.
      // Steam is inconsistent about case: appid 570 answers "game", 730 "Game".
      const type = typeof data?.type === "string" ? data.type.toLowerCase() : undefined;
      if (!data || typeof data.name !== "string" || (type && type !== "game")) {
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

  console.log("discovering from the Steam charts (live CCU + weekly peak)...");
  const chartAppids = await fromCharts();
  console.log(`  ${chartAppids.length} appids ranked by players`);

  console.log("resolving chart names against the store (1 request each)...");
  const charts = await resolveNames(chartAppids, new Map());
  console.log(`  ${charts.size} resolved as games`);

  console.log("discovering from store featuredcategories...");
  const featured = await fromFeatured();
  console.log(`  ${featured.size} appids from the featured feed`);

  console.log("resolving the curated benchmark list against the store...");
  const curated = await resolveNames(CURATED_APPIDS, new Map([...charts, ...featured]));
  console.log(`  ${curated.size} additional appids resolved`);

  // Deduplicate by appid. A title can be both charted and featured, and
  // `insert ... on conflict do update` REFUSES a batch that touches one row
  // twice ("cannot affect row a second time") — so this cannot be left to the
  // database. Lowest priority is inserted first and overwritten by the higher.
  const byAppid = new Map();
  for (const [appid, name] of featured) byAppid.set(appid, { appid, name, reason: "featured", tier: 2 });
  for (const [appid, name] of charts) byAppid.set(appid, { appid, name, reason: "charts", tier: 1 });
  for (const [appid, name] of curated) byAppid.set(appid, { appid, name, reason: "curated-benchmark", tier: 1 });
  const rows = [...byAppid.values()];
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
      [JSON.stringify(rows.map((r) => ({ appid: r.appid, name: r.name, poll_tier: r.tier, tracking_reason: r.reason })))],
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
