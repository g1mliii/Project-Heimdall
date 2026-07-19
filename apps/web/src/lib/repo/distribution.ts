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
} from "@heimdall/shared";
import type {
  CohortDistribution,
  DiagnosticRate,
  DistributionBin,
  DistributionMetric,
  DistributionMarker,
  GameDistributionQuery,
  GameDistributionResponse,
  GeneratedFrameTech,
  RayTracingMode,
  SceneType,
  UpscalerMode,
} from "@heimdall/shared";

import { getPool, query, type Queryable } from "../db";
import { cohortOutlierClassificationSql } from "../integrity/cohort-assessment";

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
  raw_run_count: string | number | null;
  excluded_outlier_count: string | number;
  viewer_is_observation: boolean;
  viewer_is_outlier: boolean;
  viewer_at_or_worse: string | number;
  sample_count: string | number | null;
  min_value: string | number | null;
  max_value: string | number | null;
  mean_value: string | number | null;
  marker_p1: string | number | null;
  marker_p50: string | number | null;
  marker_p99: string | number | null;
  /** At most 40 server-bucketed histogram bins — never raw cohort values. */
  bins: unknown;
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

interface SummaryRow {
  aggregate_eligible_runs: string | number;
  pooled_observations: string | number;
  unprofiled_runs: string | number;
  capability_unestablished_runs: string | number;
}

/** `{alias}_denom` / `{alias}_num` per {@link RATE_SPECS} entry, plus the total. */
type RatesRow = Record<string, string | number>;
type AggregateRow = SummaryRow & RatesRow;

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
  sampleCount: number,
  atOrWorse: string | number,
  viewerValue: number | null,
): number | null {
  if (viewerValue === null || sampleCount === 0) return null;
  return Math.round((Number(atOrWorse) / sampleCount) * 100);
}

function numeric(value: string | number | null): number {
  return value === null ? 0 : Number(value);
}

function distributionBins(value: unknown): DistributionBin[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((bin) => {
    if (
      bin === null ||
      typeof bin !== "object" ||
      !("lower" in bin) ||
      !("upper" in bin) ||
      !("count" in bin)
    ) {
      return [];
    }
    const { lower, upper, count } = bin;
    if (
      typeof lower !== "number" ||
      typeof upper !== "number" ||
      typeof count !== "number" ||
      !Number.isFinite(lower) ||
      !Number.isFinite(upper) ||
      !Number.isSafeInteger(count)
    ) {
      return [];
    }
    return [{ lower, upper, count }];
  });
}

function distributionMarkers(row: BucketRow): DistributionMarker[] {
  return [
    { p: 1, value: numeric(row.marker_p1) },
    { p: 50, value: numeric(row.marker_p50) },
    { p: 99, value: numeric(row.marker_p99) },
  ];
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

  const [bucketRows, aggregateRows] = await Promise.all([
    query<BucketRow>(
      `with observations as materialized ${observationsSql},
       cohort_counts as materialized (
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
       ),
       -- The response renders at most 40 bins per selected cohort. Keep the
       -- value scan in Postgres for exact MAD/sigma exclusion and percentile
       -- math, but never materialize an unbounded value/id array in either the
       -- database aggregate state sent to Node or the RSC payload.
       metrics as materialized (
         select selected.*,
                r.id as run_id,
                (${metricSql})::double precision as value
           from selected_cohorts selected
         join observations obs on true
         join runs r on r.id = obs.run_id
         join run_summaries s on s.run_id = r.id
        where ${comparabilityKeySql("r")} = selected.ck
       ),
       ${cohortOutlierClassificationSql("metrics")},
       distribution_stats as materialized (
         select ck,
                count(*) as sample_count,
                min(value) as min_value,
                max(value) as max_value,
                avg(value) as mean_value,
                percentile_disc(0.01) within group (order by value) as marker_p1,
                percentile_disc(0.5) within group (order by value) as marker_p50,
                percentile_disc(0.99) within group (order by value) as marker_p99,
                least(40, greatest(1, ceil(sqrt(count(*)::double precision))::integer)) as bin_count
           from classified
          where not is_outlier
          group by ck
       ),
       binned_values as materialized (
         select classified.ck,
                case
                  when distribution_stats.min_value = distribution_stats.max_value then 1
                  else least(
                    distribution_stats.bin_count,
                    greatest(
                      1,
                      floor(
                        (classified.value - distribution_stats.min_value) /
                        ((distribution_stats.max_value - distribution_stats.min_value) /
                         distribution_stats.bin_count)
                      )::integer + 1
                    )
                  )
                end as bin_number
           from classified
           join distribution_stats using (ck)
          where not classified.is_outlier
       ),
       bin_counts as materialized (
         select ck, bin_number, count(*) as bin_count
           from binned_values
          group by ck, bin_number
       ),
       histograms as materialized (
         select distribution_stats.ck,
                jsonb_agg(
                  jsonb_build_object(
                    'lower', case
                      when distribution_stats.min_value = distribution_stats.max_value
                        then distribution_stats.min_value
                      else distribution_stats.min_value +
                        (series.bin_number - 1) *
                        ((distribution_stats.max_value - distribution_stats.min_value) /
                         distribution_stats.bin_count)
                    end,
                    'upper', case
                      when distribution_stats.min_value = distribution_stats.max_value
                        then distribution_stats.max_value
                      when series.bin_number = distribution_stats.bin_count
                        then distribution_stats.max_value
                      else distribution_stats.min_value +
                        series.bin_number *
                        ((distribution_stats.max_value - distribution_stats.min_value) /
                         distribution_stats.bin_count)
                    end,
                    'count', coalesce(bin_counts.bin_count, 0)
                  )
                  order by series.bin_number
                ) as bins
           from distribution_stats
           cross join lateral generate_series(1, distribution_stats.bin_count) as series(bin_number)
           left join bin_counts
             on bin_counts.ck = distribution_stats.ck
            and bin_counts.bin_number = series.bin_number
          group by distribution_stats.ck
       ),
       raw_counts as materialized (
         select selected.ck,
                count(*) as raw_run_count
           from selected_cohorts selected
           join runs r on ${comparabilityKeySql("r")} = selected.ck
          where r.game_id = $1
            and ${cohortEligibilitySql("r", { allowBenchmarkSetMembers: true })}
            ${FILTER_SQL}
          group by selected.ck
       ),
       bucket_summaries as materialized (
         select metrics.ck,
                min(metrics.gpu_name) as gpu_name,
                min(metrics.gpu_id) as gpu_id,
                min(metrics.resolution) as resolution,
                min(metrics.scene_type) as scene_type,
                min(metrics.settings_preset) as settings_preset,
                min(metrics.upscaler) as upscaler,
                min(metrics.ray_tracing) as ray_tracing,
                min(metrics.graphics_api) as graphics_api,
                min(metrics.generated_frame_tech) as generated_frame_tech,
                min(metrics.observation_count) as observation_count,
                count(classified.run_id) filter (where classified.is_outlier) as excluded_outlier_count,
                coalesce(bool_or(metrics.run_id = $10::text), false) as viewer_is_observation,
                coalesce(
                  bool_or(metrics.run_id = $10::text and classified.is_outlier),
                  false
                ) as viewer_is_outlier,
                count(classified.run_id) filter (
                  where not classified.is_outlier
                    and (
                      ${direction === "lower"
                        ? "classified.value >= $11::double precision"
                        : "classified.value <= $11::double precision"}
                    )
                ) as viewer_at_or_worse,
                min(metrics.bucket_order) as bucket_order
           from metrics
           left join classified using (ck, run_id)
          group by metrics.ck
       )
       select bucket_summaries.*,
              raw_counts.raw_run_count,
              distribution_stats.sample_count,
              distribution_stats.min_value,
              distribution_stats.max_value,
              distribution_stats.mean_value,
              distribution_stats.marker_p1,
              distribution_stats.marker_p50,
              distribution_stats.marker_p99,
              histograms.bins
         from bucket_summaries
         left join distribution_stats using (ck)
         left join histograms using (ck)
         left join raw_counts using (ck)
        order by bucket_summaries.bucket_order`,
      [game.id, ...filters, viewer?.ck ?? null, MAX_COHORTS + 1, q.viewerRunId ?? null, viewer?.value ?? null],
      db,
    ),
    // Reuse one materialized observation set for both the title-level caveat
    // and diagnostic rates. The old two-query shape independently expanded the
    // benchmark-set representative window for each read; that cost grows with
    // every public run even though the response needs one combined summary.
    query<AggregateRow>(
      `with observations as materialized ${observationsSql},
       summary as materialized (
         select
         count(*) as aggregate_eligible_runs,
         count(*) filter (where not (${comparabilityProfileSql("r")})) as unprofiled_runs,
         count(*) filter (where r.capability_manifest_version is null
                             or r.capability_manifest_version < ${CAPABILITY_MANIFEST_VERSION})
           as capability_unestablished_runs,
         (select count(*) from observations) as pooled_observations
         from runs r
        where r.game_id = $1 and ${aggregateEligibilitySql("r")}
       ),
       -- §17.8 denominators include only observations evaluated at the current
       -- rule generation. The per-observation gates are computed once, and the
       -- diagnostics table is probed once per observation by this lateral.
       diagnostic_rates as materialized (
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
         ) gated
       )
       select summary.*, diagnostic_rates.*
         from summary
         cross join diagnostic_rates`,
      [game.id, DIAGNOSTICS_RULE_GENERATION],
      db,
    ),
  ]);

  const truncated = bucketRows.length > MAX_COHORTS;
  const cohorts: CohortDistribution[] = bucketRows.slice(0, MAX_COHORTS).map((row) => {
    const observationCount = Number(row.observation_count);
    const belowColdStart = observationCount < OUTLIER.minSampleSize;
    const isViewerBucket = viewer !== null && viewer.ck === row.ck;
    const viewerValue = isViewerBucket ? viewer.value : null;
    const viewerExclusion = !isViewerBucket
      ? null
      : !row.viewer_is_observation
        ? // Eligible and in this bucket, but not an observation: it is a
        // benchmark-set member whose set is represented by another run.
        ("benchmark-set-member" as const)
        : row.viewer_is_outlier
          ? ("statistical-outlier" as const)
          : null;
    const sampleCount = numeric(row.sample_count);

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
      rawRunCount: row.raw_run_count === null ? observationCount : Number(row.raw_run_count),
      distribution: belowColdStart
        ? null
        : {
            bins: distributionBins(row.bins),
            min: numeric(row.min_value),
            max: numeric(row.max_value),
            mean: numeric(row.mean_value),
            markers: distributionMarkers(row),
            sampleCount,
          },
      // The viewer's standing is against the same curve the cohort is shown.
      viewerPercentile: viewerStandingPercentile(sampleCount, row.viewer_at_or_worse, viewerValue),
      viewerValue,
      viewerExclusion,
      excludedOutlierCount: Number(row.excluded_outlier_count),
    };
  });

  const aggregate = aggregateRows[0];
  const diagnosticRates: DiagnosticRate[] = RATE_SPECS.map(({ alias, key, label }) => {
    const numerator = Number(aggregate?.[`${alias}_num`] ?? 0);
    const denominator = Number(aggregate?.[`${alias}_denom`] ?? 0);
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
      aggregateEligibleRuns: Number(aggregate?.aggregate_eligible_runs ?? 0),
      pooledObservations: Number(aggregate?.pooled_observations ?? 0),
      unprofiledRuns: Number(aggregate?.unprofiled_runs ?? 0),
      capabilityUnestablishedRuns: Number(aggregate?.capability_unestablished_runs ?? 0),
    },
    diagnosticRates,
  };
}
