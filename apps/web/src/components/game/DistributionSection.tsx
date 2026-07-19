"use client";

/**
 * The "many runs" half of the game page (§17.1–17.5): a real cohort
 * distribution with a comparability filter bar, replacing Phase 7.0's branch-
 * free {@link DistributionEmptyState}. Visual target: design/ui_kits/web/
 * GamePage.jsx (overline + filter bar + ≥30 curve / <30 cold-start branch +
 * caveat line). All spacing/color via @heimdall/ui tokens.
 *
 * The metric and workload drive a re-fetch; exact-cohort selection is a pure
 * choice among the buckets already returned. A partial filter never pools
 * incompatible profiles — each returned bucket is one exact comparability
 * match, so switching cohorts only swaps which exact cohort is shown, never
 * blends two.
 *
 * `initial` is null when the server-side read failed. The section still renders
 * and fetches for itself, so a transient failure is a retryable error card, not
 * a silently missing page region.
 */

import * as React from "react";
import { Badge, Button, Card, Diagnostic, Segmented, Select, Switch } from "@heimdall/ui";
import type {
  CohortDistribution,
  DistributionMetric,
  GameDistributionResponse,
  SceneType,
  SearchGameResult,
} from "@heimdall/shared";

import { loadGameDistribution, type ApiResult } from "@/lib/api/client";
import { DistributionChart } from "./DistributionChart";
import styles from "./DistributionSection.module.css";

export type GameDistributionLoader = (
  slug: string,
  query: { metric: DistributionMetric; sceneType?: SceneType; viewerRunId?: string },
  signal?: AbortSignal,
) => Promise<ApiResult<GameDistributionResponse>>;

const defaultLoader: GameDistributionLoader = (slug, query, signal) =>
  loadGameDistribution(slug, query, undefined, signal);

const METRIC_LABEL: Record<DistributionMetric, string> = {
  "avg-fps": "Avg FPS",
  "one-percent-low-fps": "1% low FPS",
  "point-one-percent-low-fps": "0.1% low FPS",
  "frametime-p50-ms": "Frame time p50",
  "frametime-p95-ms": "Frame time p95",
  "frametime-p99-ms": "Frame time p99",
  "stutter-rate": "Stutter rate",
  "generated-frame-share": "Generated-frame share",
};

const METRIC_OPTIONS = (Object.keys(METRIC_LABEL) as DistributionMetric[]).map((value) => ({
  value,
  label: METRIC_LABEL[value],
}));

/** "all" is the section's own workload widening; the others are exact scene types. */
type Workload = "all" | SceneType;
const WORKLOAD_OPTIONS: { value: Workload; label: string }[] = [
  { value: "benchmark-scene", label: "Benchmark scene" },
  { value: "gameplay", label: "Gameplay" },
  { value: "freeform", label: "Freeform" },
  { value: "all", label: "All" },
];

function metricFormatter(metric: DistributionMetric): (value: number) => string {
  if (metric.startsWith("frametime")) return (value) => `${value.toFixed(1)} ms`;
  if (metric === "stutter-rate") return (value) => `${(value * 100).toFixed(2)}%`;
  if (metric === "generated-frame-share") return (value) => `${Math.round(value * 100)}%`;
  return (value) => String(Math.round(value));
}

function ordinal(n: number): string {
  const mod100 = n % 100;
  if (mod100 >= 11 && mod100 <= 13) return `${n}th`;
  switch (n % 10) {
    case 1:
      return `${n}st`;
    case 2:
      return `${n}nd`;
    case 3:
      return `${n}rd`;
    default:
      return `${n}th`;
  }
}

/** How a viewer run that is not itself part of the curve is explained. */
const VIEWER_EXCLUSION_NOTE: Record<
  NonNullable<CohortDistribution["viewerExclusion"]>,
  string
> = {
  "statistical-outlier":
    "Your run is excluded from this curve as a statistical outlier — it is still ranked against the cohort above, and still listed below.",
  "benchmark-set-member":
    "Your run is part of a repeat benchmark set, which pools as a single observation — the set's median run is the point on this curve. Your own value is ranked against it above.",
};

/**
 * Every returned item is already one exact comparability bucket. Selecting by
 * GPU alone hid all but the first bucket when one GPU had multiple resolutions
 * or methodology profiles, so retain every comparability field in the local
 * identity. This is UI-only; the value never reaches a query.
 */
function cohortKey(cohort: CohortDistribution | undefined): string | null {
  if (!cohort) return null;
  const { comparability } = cohort;
  return [
    comparability.gpuId,
    comparability.gpu,
    comparability.resolution,
    comparability.sceneType,
    comparability.settingsPreset,
    comparability.upscaler,
    comparability.rayTracing,
    comparability.graphicsApi,
    comparability.frameGeneration,
  ].map((part) => part ?? "").join("\u001f");
}

/** Keep the selected native-control value legible while the full GPU name remains in the card. */
function compactGpuLabel(gpu: string | null): string {
  return (gpu ?? "Unknown GPU").replace(/^(NVIDIA GeForce|AMD Radeon)\s+/i, "");
}

function cohortOptions(data: GameDistributionResponse): { value: string; label: string }[] {
  return data.cohorts.flatMap((cohort) => {
    const key = cohortKey(cohort);
    if (key === null) return [];
    const { comparability } = cohort;
    const profile = [
      compactGpuLabel(comparability.gpu),
      comparability.resolution ?? "unknown resolution",
      comparability.sceneType ?? "unknown workload",
      comparability.settingsPreset ?? "unknown preset",
      comparability.graphicsApi?.toUpperCase() ?? "unknown API",
    ];
    return [{ value: key, label: profile.join(" · ") }];
  });
}

export function DistributionSection({
  game,
  initial,
  viewerRunId,
  loadDistribution = defaultLoader,
}: {
  game: SearchGameResult;
  /** null when the server-side read failed; the section then fetches its own. */
  initial: GameDistributionResponse | null;
  viewerRunId?: string;
  loadDistribution?: GameDistributionLoader;
}) {
  const [data, setData] = React.useState(initial);
  const [metric, setMetric] = React.useState<DistributionMetric>(initial?.metric ?? "avg-fps");
  const [workload, setWorkload] = React.useState<Workload>("all");
  const [selectedCohortKey, setSelectedCohortKey] = React.useState<string | null>(() =>
    cohortKey(initial?.cohorts[0]),
  );
  const [loading, setLoading] = React.useState(initial === null);
  const [error, setError] = React.useState<string | null>(null);
  /** Bumped by the retry button to re-run the fetch effect. */
  const [reloadToken, setReloadToken] = React.useState(0);

  const controller = React.useRef<AbortController | null>(null);
  const requestId = React.useRef(0);
  // Only skip the first fetch when the server already supplied the data.
  const isInitial = React.useRef(initial !== null);

  React.useEffect(
    () => () => {
      requestId.current += 1;
      controller.current?.abort();
    },
    [],
  );

  // Re-fetch when the metric or workload changes (they change which buckets
  // exist). Exact-cohort selection is handled purely client-side below.
  React.useEffect(() => {
    if (isInitial.current) {
      isInitial.current = false;
      return;
    }
    controller.current?.abort();
    const nextController = new AbortController();
    controller.current = nextController;
    const current = ++requestId.current;
    setLoading(true);
    setError(null);

    void loadDistribution(
      game.slug,
      {
        metric,
        ...(workload === "all" ? {} : { sceneType: workload }),
        ...(viewerRunId ? { viewerRunId } : {}),
      },
      nextController.signal,
    ).then((result) => {
      if (current !== requestId.current) return;
      if (result.ok) {
        setData(result.data);
        setSelectedCohortKey((previous) => {
          const options = cohortOptions(result.data);
          return options.some((option) => option.value === previous)
            ? previous
            : (options[0]?.value ?? null);
        });
      } else if (result.code !== "aborted") {
        setError(result.message);
      }
      setLoading(false);
    }).catch((loadError: unknown) => {
      if (current !== requestId.current || nextController.signal.aborted) return;
      setError(loadError instanceof Error ? loadError.message : "The distribution could not be read.");
      setLoading(false);
    });
  }, [metric, workload, viewerRunId, game.slug, loadDistribution, reloadToken]);

  const options = React.useMemo(() => (data ? cohortOptions(data) : []), [data]);
  // Cohorts arrive with the viewer's own bucket pinned first, then most-observed.
  // Crucially, this selects its full profile rather than a GPU's first profile.
  const cohort =
    data?.cohorts.find((entry) => cohortKey(entry) === selectedCohortKey) ??
    data?.cohorts[0] ??
    null;
  // Stable across re-renders so the chart and meta rows can memoize on it.
  const format = React.useMemo(() => metricFormatter(metric), [metric]);
  const exclusionSummary = data?.exclusionSummary ?? null;

  return (
    <section className={styles.section} aria-label="Performance distribution">
      <span className={styles.overline}>
        {exclusionSummary
          ? `Aggregate · ${exclusionSummary.aggregateEligibleRuns.toLocaleString()} public runs`
          : "Aggregate"}
      </span>
      <p className={styles.lede}>Where your run sits in the crowd, by hardware configuration.</p>

      <div className={styles.filterBar} role="group" aria-label="Distribution filters">
        {options.length > 0 && (
          <Select
            aria-label="Exact cohort"
            className={styles.cohortSelect}
            value={selectedCohortKey ?? ""}
            onChange={(event) => setSelectedCohortKey(event.target.value)}
            options={options}
          />
        )}
        <Select
          aria-label="Metric"
          value={metric}
          onChange={(event) => setMetric(event.target.value as DistributionMetric)}
          options={METRIC_OPTIONS}
        />
        <Segmented
          // Distinct from the submissions table's own "Workload" control — the
          // two now coexist on the game page and must be separable by name.
          aria-label="Distribution workload"
          value={workload}
          onChange={(value) => setWorkload(value as Workload)}
          options={WORKLOAD_OPTIONS}
        />
        <div className={styles.spacer} />
        {/* Placeholder for the Phase 8 verified-tier filter: the read model does
            not honour it yet, so it stays inert rather than carrying state that
            never reaches a query. */}
        <Switch checked={false} readOnly disabled label="Verified only" />
      </div>

      <p className={styles.caveat}>
        Aggregates compare like workloads only — freeform gameplay is noisier than a canned
        benchmark scene, so the three never share a cohort.
      </p>

      {data?.truncated && (
        <p className={styles.caveat}>
          This title has more hardware configurations than one response returns — the GPU list above
          shows the most-submitted ones{viewerRunId ? ", plus your own" : ""}. Narrow the workload to
          reach a configuration that is not listed.
        </p>
      )}

      {loading ? (
        <Card className={styles.stateCard}>
          <Card.Body>
            <p className={styles.muted}>Loading distribution…</p>
          </Card.Body>
        </Card>
      ) : error || data === null ? (
        <Card className={styles.stateCard}>
          <Card.Body>
            <Diagnostic severity="warn" title="Could not load the distribution">
              {error ?? "The distribution could not be read."}
            </Diagnostic>
            <Button
              variant="secondary"
              onClick={() => {
                setError(null);
                setReloadToken((token) => token + 1);
              }}
            >
              Retry
            </Button>
          </Card.Body>
        </Card>
      ) : cohort === null ? (
        <Card className={styles.stateCard}>
          <Card.Header title="Performance distribution" />
          <Card.Body>
            <Diagnostic severity="info" title="Insufficient comparable data">
              No comparable public runs share a complete methodology profile yet. Individual
              submissions are listed below.
            </Diagnostic>
          </Card.Body>
        </Card>
      ) : cohort.distribution ? (
        <Card className={styles.stateCard}>
          <Card.Header
            title={`${METRIC_LABEL[metric]} distribution · ${cohort.comparability.gpu ?? "GPU"}`}
            actions={
              <span className={styles.badgeRow}>
                <Badge tone="neutral">
                  {cohort.observationCount} {cohort.observationCount === 1 ? "run" : "runs"}
                </Badge>
                {cohort.viewerPercentile !== null && (
                  <Badge tone="brand">
                    You: {ordinal(cohort.viewerPercentile)} percentile
                    {data.betterDirection === "lower"
                      ? " (lower is better)"
                      : data.betterDirection === "neutral"
                        ? " (by value)"
                        : ""}
                  </Badge>
                )}
              </span>
            }
          />
          <Card.Body>
            <Card variant="inset" className={styles.chartInset}>
              <DistributionChart
                distribution={cohort.distribution}
                viewerValue={cohort.viewerValue}
                viewerPercentile={cohort.viewerPercentile}
                formatValue={format}
              />
            </Card>
            <CohortMeta cohort={cohort} format={format} />
          </Card.Body>
        </Card>
      ) : (
        <Card className={styles.stateCard}>
          <Card.Header
            title={cohort.comparability.gpu ?? "GPU"}
            actions={
              <Badge tone="warn">
                {cohort.observationCount} {cohort.observationCount === 1 ? "run" : "runs"}
              </Badge>
            }
          />
          <Card.Body>
            <Diagnostic severity="info" title="Insufficient data for a distribution">
              Only {cohort.observationCount}{" "}
              {cohort.observationCount === 1 ? "run exists" : "runs exist"} for this configuration —
              below the {data.minSampleSize}-run minimum. A curve over a handful of runs would be
              noise, not signal, so the individual submissions are listed below instead.
            </Diagnostic>
            <CohortMeta cohort={cohort} format={format} />
          </Card.Body>
        </Card>
      )}

      {data && data.diagnosticRates.length > 0 && (
        <Card className={styles.stateCard}>
          <Card.Header title="Support patterns across the cohort" />
          <Card.Body>
            <p className={styles.metaNote}>
              Observational rates over runs evaluated at the current diagnostics rules — support
              patterns, not causal rankings. A rate is unavailable when no run carries the telemetry
              its rule needs.
            </p>
            <div className={styles.rates}>
              {data.diagnosticRates.map((diagnosticRate) => (
                <div key={diagnosticRate.key} className={styles.rate}>
                  <span className={styles.rateLabel}>{diagnosticRate.label}</span>
                  {diagnosticRate.ratePct === null ? (
                    <span className={styles.rateUnavailable}>unavailable</span>
                  ) : (
                    <span className={styles.rateValue} data-mono>
                      {diagnosticRate.ratePct}%{" "}
                      <span className={styles.rateDenominator}>
                        ({diagnosticRate.numerator}/{diagnosticRate.denominator})
                      </span>
                    </span>
                  )}
                </div>
              ))}
            </div>
          </Card.Body>
        </Card>
      )}

      {data && exclusionSummary && (
        <p className={styles.footnote}>
          {exclusionSummary.pooledObservations.toLocaleString()}{" "}
          {exclusionSummary.pooledObservations === 1
            ? "independent observation"
            : "independent observations"}{" "}
          pooled from {exclusionSummary.aggregateEligibleRuns.toLocaleString()} public runs.
          {exclusionSummary.unprofiledRuns > 0 &&
            ` ${exclusionSummary.unprofiledRuns.toLocaleString()} excluded for an incomplete methodology profile.`}
          {exclusionSummary.capabilityUnestablishedRuns > 0 &&
            ` ${exclusionSummary.capabilityUnestablishedRuns.toLocaleString()} predate the current capability contract.`}{" "}
          Cohort definition v{data.cohortDefinitionVersion}.
        </p>
      )}
    </section>
  );
}

/** The exact comparability recipe + count honesty for the shown cohort. */
function CohortMeta({
  cohort,
  format,
}: {
  cohort: CohortDistribution;
  format: (value: number) => string;
}) {
  const { comparability } = cohort;
  const chips = [
    comparability.resolution,
    comparability.graphicsApi,
    comparability.upscaler && comparability.upscaler !== "none"
      ? `${comparability.upscaler.toUpperCase()} upscaling`
      : null,
    comparability.rayTracing === "on" ? "ray tracing" : null,
    comparability.settingsPreset,
  ].filter((chip): chip is string => Boolean(chip));

  return (
    <div className={styles.meta}>
      <div className={styles.chips}>
        {chips.map((chip) => (
          <span key={chip} className={styles.chip} data-mono>
            {chip}
          </span>
        ))}
      </div>
      {cohort.rawRunCount !== cohort.observationCount && (
        <span className={styles.metaNote}>
          {cohort.observationCount}{" "}
          {cohort.observationCount === 1 ? "independent observation" : "independent observations"}{" "}
          across {cohort.rawRunCount} runs — repeat benchmark sets weigh once.
        </span>
      )}
      {cohort.excludedOutlierCount > 0 && (
        <span className={styles.metaNote}>
          {cohort.excludedOutlierCount}{" "}
          {cohort.excludedOutlierCount === 1 ? "run" : "runs"} excluded from the curve as statistical
          outliers — still listed below, never hidden.
        </span>
      )}
      {cohort.viewerExclusion !== null && (
        <span className={styles.metaNote}>{VIEWER_EXCLUSION_NOTE[cohort.viewerExclusion]}</span>
      )}
      {cohort.distribution && (
        <span className={styles.metaNote} data-mono>
          mean {format(cohort.distribution.mean)}
        </span>
      )}
    </div>
  );
}
