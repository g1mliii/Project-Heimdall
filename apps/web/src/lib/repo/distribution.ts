/**
 * Aggregate cohort distribution read (§17). The "many runs" half of the game
 * page: it pools comparable public + validated runs into a statistical
 * distribution, weighting each repeated benchmark set as ONE observation.
 *
 * Request-time aggregation over `run_summaries` — the precomputed Postgres
 * summaries — never per-frame data in R2. It mirrors `readVisibleBenchmarkSet`:
 * the shared `cohortObservationsSql` observation set (which collapses each set
 * to its representative) grouped by the shared `comparabilityKeySql`, so a
 * `benchmark-scene` bucket never pools with `gameplay` and no query re-derives
 * the cohort policy. Buckets are narrow exact-methodology matches and
 * index-backed, so a single distribution is a small aggregate even for a
 * popular title.
 *
 * Below {@link OUTLIER.minSampleSize} independent observations a cohort is a
 * cold start (§17.4): the read returns the honest counts and NO curve, so the
 * UI shows raw submissions instead of a misleading average over too few runs.
 */

import {
  CAPABILITY_MANIFEST_VERSION,
  COHORT_DEFINITION_VERSION,
  DIAGNOSTICS_RULE_GENERATION,
  OUTLIER,
  aggregateEligibilitySql,
  cohortEligibilitySql,
  cohortObservationsSql,
  comparabilityKeySql,
  comparabilityProfileSql,
  empiricalDistributionBins,
  statisticalOutlierMask,
} from "@heimdall/shared";
import type {
  CohortDistribution,
  DiagnosticRate,
  DistributionMetric,
  GameDistributionQuery,
  GameDistributionResponse,
  GeneratedFrameTech,
  RayTracingMode,
  SceneType,
  UpscalerMode,
} from "@heimdall/shared";

import { getPool, query, type Queryable } from "../db";

/** At most this many buckets per response; `truncated` flags when more existed. */
const MAX_COHORTS = 50;

/**
 * Metric → `run_summaries` column/expression. Keyed by the zod-validated enum,
 * so the interpolated fragment is a fixed developer-authored string, never
 * request input — no injection surface. Every metric is frame-derived (frame
 * times or generated-frame flags), so a cohort's capability gate is enough; no
 * per-metric sensor requirement (those are §17.8 aggregate diagnostics).
 */
const METRIC_SQL: Record<DistributionMetric, string> = {
  "avg-fps": "s.avg_fps",
  "one-percent-low-fps": "s.p1_low_fps",
  "point-one-percent-low-fps": "s.p01_low_fps",
  "frametime-p50-ms": "s.frametime_p50_ms",
  "frametime-p95-ms": "s.frametime_p95_ms",
  "frametime-p99-ms": "s.frametime_p99_ms",
  "stutter-rate": "(s.stutter_count::double precision / nullif(s.sample_count, 0))",
  "generated-frame-share": "s.generated_frame_pct",
};

const METRIC_DIRECTION: Record<DistributionMetric, "higher" | "lower" | "neutral"> = {
  "avg-fps": "higher",
  "one-percent-low-fps": "higher",
  "point-one-percent-low-fps": "higher",
  "frametime-p50-ms": "lower",
  "frametime-p95-ms": "lower",
  "frametime-p99-ms": "lower",
  "stutter-rate": "lower",
  "generated-frame-share": "neutral",
};

/**
 * Cohort filters as `($n is null or col = $n)` guards. The same six placeholders
 * scope both the observation query and the raw-count query so their buckets
 * align by comparability key. `r` is the runs alias in both.
 */
const FILTER_SQL = `and ($2::bigint is null or r.gpu_hardware_id = $2::bigint)
    and ($3::text is null or r.scene_type = $3::text)
    and ($4::text is null or r.resolution = $4::text)
    and ($5::text is null or r.settings_preset = $5::text)
    and ($6::text is null or r.upscaler = $6::text)
    and ($7::text is null or r.ray_tracing = $7::text)`;

interface GameRow {
  id: string;
  slug: string;
  name: string;
}

interface BucketRow {
  ck: string;
  gpu_name: string | null;
  gpu_id: string | null;
  resolution: string | null;
  scene_type: SceneType | null;
  settings_preset: string | null;
  upscaler: UpscalerMode | null;
  ray_tracing: RayTracingMode | null;
  graphics_api: string | null;
  generated_frame_tech: GeneratedFrameTech;
  observation_count: string | number;
  metric_values: (string | number | null)[] | null;
  /** Observation run ids, aggregated in the SAME order as `metric_values`. */
  observation_run_ids: string[] | null;
}

/**
 * The viewer's own run, read directly rather than through the observation set.
 * A benchmark-set member that is not its set's representative is absent from
 * `observations` entirely, so reading the marker from there loses it for every
 * set member but one — the exact case `?run=` exists to serve.
 */
interface ViewerRow {
  ck: string;
  value: string | number | null;
}

interface RawCountRow {
  ck: string;
  raw_run_count: string | number;
}

interface SummaryRow {
  aggregate_eligible_runs: string | number;
  pooled_observations: string | number;
  unprofiled_runs: string | number;
  capability_unestablished_runs: string | number;
}

/** `{alias}_denom` / `{alias}_num` per {@link RATE_SPECS} entry, plus the total. */
type RatesRow = Record<string, string | number>;

/** A run's sensor is usable for an aggregate rate only if present AND frame-aligned. */
function sensorReadySql(field: string): string {
  return `((r.capability_manifest -> 'sensors' -> '${field}' ->> 'present')::boolean
    and (r.capability_manifest -> 'sensors' -> '${field}' ->> 'frameAligned')::boolean)`;
}

/**
 * §17.8 aggregate diagnostic rates, one entry per reported rate. Each states its
 * telemetry gate ONCE — the denominator counts observations that pass it and the
 * numerator counts that same gate plus a finding — so a rate can never exceed
 * 100% by the two drifting apart. All fragments are developer-authored.
 */
const RATE_SPECS: {
  alias: string;
  key: DiagnosticRate["key"];
  label: string;
  /** Telemetry the rule needs; null when every evaluated observation qualifies. */
  telemetrySql: string | null;
  /** Diagnostic codes that count as a finding for this rate. */
  codes: string[];
}[] = [
  {
    alias: "driver",
    key: "driver-currency",
    label: "Behind on GPU drivers",
    telemetrySql: null,
    codes: ["driver-update-available", "gpu-driver-outdated"],
  },
  {
    alias: "vram",
    key: "vram-pressure",
    label: "VRAM-saturation stutter",
    telemetrySql: `${sensorReadySql("vramUsedMb")}
      and (r.capability_manifest -> 'vramCapacity' ? 'totalMb')`,
    codes: ["vram-saturation-stutter"],
  },
  {
    alias: "cpu",
    key: "cpu-bound",
    label: "CPU-bound",
    telemetrySql: `${sensorReadySql("cpuLoadPct")} and ${sensorReadySql("gpuLoadPct")}`,
    codes: ["cpu-bottleneck"],
  },
];

function rate(numerator: number, denominator: number): number | null {
  return denominator > 0 ? Math.round((numerator / denominator) * 100) : null;
}

/** Filter parameters shared by the observation and raw-count queries. */
function filterParams(q: GameDistributionQuery): [
  string | null,
  SceneType | null,
  string | null,
  string | null,
  UpscalerMode | null,
  RayTracingMode | null,
] {
  return [
    q.gpuId ?? null,
    q.sceneType ?? null,
    q.resolution ?? null,
    q.settingsPreset ?? null,
    q.upscaler ?? null,
    q.rayTracing ?? null,
  ];
}

/**
 * The viewer's standing inside its bucket (0–100, nearest int): the share of
 * comparable observations their value is at least as good as.
 *
 * Direction-aware on purpose. A raw at-or-below rank inverts the meaning of
 * every lower-is-better metric — the best frame time in a cohort would render
 * as "2nd percentile" — so the comparison flips with `betterDirection` and the
 * number always reads as "higher is a better result".
 */
function viewerStandingPercentile(
  values: number[],
  viewerValue: number | null,
  direction: "higher" | "lower" | "neutral",
): number | null {
  if (viewerValue === null || values.length === 0) return null;
  const atOrWorse = values.reduce(
    (count, value) =>
      (direction === "lower" ? value >= viewerValue : value <= viewerValue) ? count + 1 : count,
    0,
  );
  return Math.round((atOrWorse / values.length) * 100);
}

/**
 * Read the viewer run's own comparability bucket and metric value, independent
 * of the observation collapse so a benchmark-set member keeps its marker.
 * Returns null when the run is unknown, belongs to another game, or is not
 * cohort-eligible (a private or pending run gets no marker, by design).
 */
async function readViewerObservation(
  gameId: string,
  viewerRunId: string,
  metricSql: string,
  db: Queryable,
): Promise<{ ck: string; value: number } | null> {
  const rows = await query<ViewerRow>(
    `select ${comparabilityKeySql("r")} as ck, ${metricSql} as value
       from runs r
       join run_summaries s on s.run_id = r.id
      where r.id = $2::text
        and r.game_id = $1
        and ${cohortEligibilitySql("r", { allowBenchmarkSetMembers: true })}`,
    [gameId, viewerRunId],
    db,
  );
  const row = rows[0];
  if (!row || row.value === null) return null;
  return { ck: row.ck, value: Number(row.value) };
}

/**
 * Read a game's cohort distribution for one metric, grouped into exact
 * comparability buckets. Returns null only when the game slug is unknown; an
 * empty `cohorts` array is a valid answer (no comparable runs yet).
 */
export async function readGameDistribution(
  slug: string,
  q: GameDistributionQuery,
  db: Queryable = getPool(),
): Promise<GameDistributionResponse | null> {
  const gameRows = await query<GameRow>(
    "select id::text as id, slug, name from games where slug = $1",
    [slug],
    db,
  );
  const game = gameRows[0];
  if (!game) return null;

  const metricSql = METRIC_SQL[q.metric];
  const filters = filterParams(q);
  const direction = METRIC_DIRECTION[q.metric];
  // Scoped to this title INSIDE the union so the set branch's window function
  // ranks one game's members, not the whole catalog's (see cohortObservationsSql).
  const observationsSql = cohortObservationsSql({ scopeSql: "r.game_id = $1" });

  // Resolved first (a single indexed row) so the bucket query can PIN the
  // viewer's bucket ahead of the MAX_COHORTS cap — otherwise a mid-tier GPU on a
  // popular title falls off the end of the list and the viewer's own hardware
  // silently disappears from the selector.
  const viewer = q.viewerRunId
    ? await readViewerObservation(game.id, q.viewerRunId, metricSql, db)
    : null;

  const [bucketRows, summaryRows, ratesRows] = await Promise.all([
    query<BucketRow>(
      `with observations as ${observationsSql}
       , cohort_counts as materialized (
       select ${comparabilityKeySql("r")} as ck,
               min(coalesce(gpu.canonical_name, r.gpu_model)) as gpu_name,
               min(r.gpu_hardware_id::text) as gpu_id,
              min(r.resolution) as resolution,
              min(r.scene_type) as scene_type,
              min(r.settings_preset) as settings_preset,
              min(r.upscaler) as upscaler,
               min(r.ray_tracing) as ray_tracing,
               min(r.graphics_api) as graphics_api,
               min(r.generated_frame_tech) as generated_frame_tech,
               count(*) as observation_count
          from observations obs
          join runs r on r.id = obs.run_id
          left join hardware gpu on gpu.id = r.gpu_hardware_id and gpu.kind = 'gpu'
         where r.game_id = $1
           ${FILTER_SQL}
        group by ck
       ), selected_cohorts as materialized (
         select cohort_counts.*,
                row_number() over (
                  order by ($8::text is not null and ck = $8::text) desc,
                           observation_count desc, ck
                ) as bucket_order
           from cohort_counts
          order by ($8::text is not null and ck = $8::text) desc,
                   observation_count desc, ck
          limit $9
       )
       -- Select the top exact profiles before collecting point values. The old
       -- one-stage GROUP BY built arrays for every profile in a popular title,
       -- even though the response exposes at most MAX_COHORTS. Values and ids
       -- are now retained only for the bounded response set.
       select selected.ck,
              selected.gpu_name,
              selected.gpu_id,
              selected.resolution,
              selected.scene_type,
              selected.settings_preset,
              selected.upscaler,
              selected.ray_tracing,
              selected.graphics_api,
              selected.generated_frame_tech,
              selected.observation_count,
              array_agg(${metricSql} order by r.id) as metric_values,
              array_agg(r.id order by r.id) as observation_run_ids
         from selected_cohorts selected
         join observations obs on true
         join runs r on r.id = obs.run_id
         join run_summaries s on s.run_id = r.id
        where ${comparabilityKeySql("r")} = selected.ck
        group by selected.ck, selected.gpu_name, selected.gpu_id,
                 selected.resolution, selected.scene_type, selected.settings_preset,
                 selected.upscaler, selected.ray_tracing, selected.graphics_api,
                 selected.generated_frame_tech, selected.observation_count,
                 selected.bucket_order
        order by selected.bucket_order`,
      [game.id, ...filters, viewer?.ck ?? null, MAX_COHORTS + 1],
      db,
    ),
    // Game-level inclusion summary — independent of the current filter, so the
    // caveat line reads over the whole title, not just the shown bucket.
    // One scan over the title's aggregate-eligible runs with FILTER clauses,
    // rather than three scalar subqueries repeating the same predicate.
    query<SummaryRow>(
      `with observations as ${observationsSql}
       select
         count(*) as aggregate_eligible_runs,
         count(*) filter (where not (${comparabilityProfileSql("r")})) as unprofiled_runs,
         count(*) filter (where r.capability_manifest_version is null
                             or r.capability_manifest_version < ${CAPABILITY_MANIFEST_VERSION})
           as capability_unestablished_runs,
         (select count(*) from observations) as pooled_observations
         from runs r
        where r.game_id = $1 and ${aggregateEligibilitySql("r")}`,
      [game.id],
      db,
    ),
    // §17.8 aggregate diagnostic rates. Denominators count only observations
    // evaluated at the CURRENT diagnostics generation (§17.8.0 — so "evaluated,
    // did not fire" is distinct from "never evaluated") that ALSO carry the
    // telemetry the rule needs. A sensor-derived rate with no eligible telemetry
    // reports a zero denominator → the caller renders "unavailable", never 0%.
    //
    // The per-observation gates are computed ONCE in the inner select, and the
    // diagnostics table is probed once per observation by a lateral rather than
    // by one correlated `exists` per rate.
    query<RatesRow>(
      `with observations as ${observationsSql}
       select ${RATE_SPECS.map(
                ({ alias }) => `count(*) filter (where evaluated and ${alias}_ready)
                as ${alias}_denom,
              count(*) filter (where evaluated and ${alias}_ready and ${alias}_hit)
                as ${alias}_num`,
              ).join(",\n              ")}
         from (
           select r.diagnostics_rule_generation = $2 as evaluated,
                  ${RATE_SPECS.map(
                    ({ alias, telemetrySql }) =>
                      `(${telemetrySql ?? "true"}) as ${alias}_ready`,
                  ).join(",\n                  ")},
                  ${RATE_SPECS.map(
                    ({ alias }) => `coalesce(dx.${alias}_hit, false) as ${alias}_hit`,
                  ).join(",\n                  ")}
             from observations obs
             join runs r on r.id = obs.run_id
             left join lateral (
               select ${RATE_SPECS.map(
                 ({ alias, codes }) =>
                   `bool_or(d.code in (${codes.map((code) => `'${code}'`).join(", ")}))
                    as ${alias}_hit`,
               ).join(",\n                      ")}
                 from diagnostics d
                where d.run_id = r.id
             ) dx on true
         ) gated`,
      [game.id, DIAGNOSTICS_RULE_GENERATION],
      db,
    ),
  ]);

  // Raw run counts are needed only for the profiles that will actually render.
  // This stays separate from the observation query because a benchmark set
  // weighs once in a curve but every submitted member must remain visible in
  // the count. Querying just the bounded result keys avoids grouping every raw
  // profile solely to discard it after the response cap.
  const displayedKeys = bucketRows.slice(0, MAX_COHORTS).map((row) => row.ck);
  const rawCountRows =
    displayedKeys.length === 0
      ? []
      : await query<RawCountRow>(
          `select ${comparabilityKeySql("r")} as ck, count(*) as raw_run_count
             from runs r
            where r.game_id = $1
              and ${cohortEligibilitySql("r", { allowBenchmarkSetMembers: true })}
              ${FILTER_SQL}
              and ${comparabilityKeySql("r")} = any($8::text[])
            group by ck`,
          [game.id, ...filters, displayedKeys],
          db,
        );

  const rawByKey = new Map(rawCountRows.map((row) => [row.ck, Number(row.raw_run_count)]));

  const truncated = bucketRows.length > MAX_COHORTS;
  const cohorts: CohortDistribution[] = bucketRows.slice(0, MAX_COHORTS).map((row) => {
    const rawValues = row.metric_values ?? [];
    const runIds = row.observation_run_ids ?? [];
    // Keep run ids aligned with values across the null filter, so an outlier
    // index still identifies the right run.
    const kept = rawValues
      .map((value, index) => ({ value, runId: runIds[index] }))
      .filter((entry): entry is { value: string | number; runId: string | undefined } =>
        entry.value !== null,
      );
    const values = kept.map((entry) => Number(entry.value));
    const observationCount = Number(row.observation_count);

    // Cold-start guard: a curve — and outlier rejection — only above the shared
    // threshold (§17.4/§18.2). Outliers are dropped from the curve but stay
    // counted and never hidden; their runs remain in the submissions list.
    const belowColdStart = observationCount < OUTLIER.minSampleSize;
    const outlierMask = belowColdStart ? [] : statisticalOutlierMask(values);
    const included = belowColdStart ? values : values.filter((_, i) => !outlierMask[i]);
    const excludedOutlierCount = values.length - included.length;

    // The viewer's value belongs to THIS bucket only when their run's own
    // comparability key matches it.
    const isViewerBucket = viewer !== null && viewer.ck === row.ck;
    const viewerValue = isViewerBucket ? viewer.value : null;
    const viewerIndex =
      viewer === null ? -1 : kept.findIndex((entry) => entry.runId === q.viewerRunId);
    const viewerExclusion = !isViewerBucket
      ? null
      : viewerIndex === -1
        ? // Eligible and in this bucket, but not an observation: it is a
          // benchmark-set member whose set is represented by another run.
          ("benchmark-set-member" as const)
        : outlierMask[viewerIndex]
          ? ("statistical-outlier" as const)
          : null;

    return {
      comparability: {
        gpu: row.gpu_name,
        gpuId: row.gpu_id,
        resolution: row.resolution,
        sceneType: row.scene_type,
        settingsPreset: row.settings_preset,
        upscaler: row.upscaler,
        rayTracing: row.ray_tracing,
        graphicsApi: row.graphics_api,
        frameGeneration: row.generated_frame_tech,
      },
      observationCount,
      rawRunCount: rawByKey.get(row.ck) ?? observationCount,
      distribution: belowColdStart ? null : empiricalDistributionBins(included),
      // The viewer's standing is against the same curve the cohort is shown.
      viewerPercentile: viewerStandingPercentile(included, viewerValue, direction),
      viewerValue,
      viewerExclusion,
      excludedOutlierCount,
    };
  });

  const summary = summaryRows[0];
  const ratesRow = ratesRows[0];
  const diagnosticRates: DiagnosticRate[] = RATE_SPECS.map(({ alias, key, label }) => {
    const numerator = Number(ratesRow?.[`${alias}_num`] ?? 0);
    const denominator = Number(ratesRow?.[`${alias}_denom`] ?? 0);
    return { key, label, numerator, denominator, ratePct: rate(numerator, denominator) };
  });

  return {
    game: { id: game.id, slug: game.slug, name: game.name },
    metric: q.metric,
    betterDirection: direction,
    cohortDefinitionVersion: COHORT_DEFINITION_VERSION,
    minSampleSize: OUTLIER.minSampleSize,
    cohorts,
    truncated,
    exclusionSummary: {
      aggregateEligibleRuns: Number(summary?.aggregate_eligible_runs ?? 0),
      pooledObservations: Number(summary?.pooled_observations ?? 0),
      unprofiledRuns: Number(summary?.unprofiled_runs ?? 0),
      capabilityUnestablishedRuns: Number(summary?.capability_unestablished_runs ?? 0),
    },
    diagnosticRates,
  };
}
