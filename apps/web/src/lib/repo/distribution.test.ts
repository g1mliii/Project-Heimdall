import { OUTLIER } from "@heimdall/shared";
import type { GameDistributionQuery } from "@heimdall/shared";
import { describe, expect, it } from "vitest";

import type { Queryable } from "../db";
import { readGameDistribution } from "./distribution";

/**
 * Fake `Queryable` that routes each of the read model's queries to canned rows
 * by a fragment of its SQL — enough to exercise the pure assembly (cold-start
 * gating, observation-vs-raw counts, viewer percentile, truncation) without a
 * container-backed Postgres. The end-to-end SQL is covered by the §19 DB tests.
 */
function fakeDb(responses: {
  game?: unknown[];
  viewer?: unknown[];
  buckets?: unknown[];
  summary?: unknown[];
  rates?: unknown[];
  onQuery?: (text: string) => void;
}): Queryable {
  const query = (text: string): Promise<{ rows: unknown[] }> => {
    responses.onQuery?.(text);
    let rows: unknown[] = [];
    if (text.includes("from games where slug")) rows = responses.game ?? [];
    else if (text.includes("where r.id = $2::text")) rows = responses.viewer ?? [];
    else if (text.includes("bucket_summaries")) rows = responses.buckets ?? [];
    else if (text.includes("pooled_observations")) {
      const summary = responses.summary?.[0];
      const rates = responses.rates?.[0];
      rows = [
        {
          ...(summary !== null && typeof summary === "object" ? summary : {}),
          ...(rates !== null && typeof rates === "object" ? rates : {}),
        },
      ];
    }
    return Promise.resolve({ rows });
  };
  return { query } as unknown as Queryable;
}

const GAME = [{ id: "42", slug: "cyberpunk-2077", name: "Cyberpunk 2077" }];
const SUMMARY = [
  {
    aggregate_eligible_runs: 60,
    pooled_observations: 35,
    unprofiled_runs: 12,
    capability_unestablished_runs: 3,
  },
];

const baseQuery: GameDistributionQuery = { metric: "avg-fps" };

function bucketRow(overrides: Record<string, unknown>) {
  return {
    ck: "ck-default",
    gpu_name: "GeForce RTX 4090",
    gpu_id: "7",
    resolution: "2560x1440",
    scene_type: "benchmark-scene",
    settings_preset: "Ultra",
    upscaler: "dlss",
    ray_tracing: "on",
    graphics_api: "dx12",
    generated_frame_tech: "dlss3",
    observation_count: 30,
    raw_run_count: 30,
    excluded_outlier_count: 0,
    viewer_is_observation: true,
    viewer_is_outlier: false,
    viewer_at_or_worse: 21,
    sample_count: 30,
    min_value: 100,
    max_value: 129,
    mean_value: 114.5,
    marker_p1: 100,
    marker_p50: 114,
    marker_p99: 129,
    bins: [{ lower: 100, upper: 129, count: 30 }],
    ...overrides,
  };
}

describe("readGameDistribution", () => {
  it("returns null for an unknown game slug", async () => {
    const result = await readGameDistribution("nope", baseQuery, fakeDb({ game: [] }));
    expect(result).toBeNull();
  });

  it("keeps the selected-cohort payload bounded to histogram bins", async () => {
    const sql: string[] = [];
    await readGameDistribution(
      "cyberpunk-2077",
      baseQuery,
      fakeDb({ game: GAME, buckets: [bucketRow({})], summary: SUMMARY, onQuery: (text) => sql.push(text) }),
    );

    const bucketQuery = sql.find((text) => text.includes("bucket_summaries"));
    expect(bucketQuery).toContain("histograms");
    expect(bucketQuery).not.toContain("array_agg");
  });

  it("draws a curve at/above the cold-start threshold and withholds it below", async () => {
    const buckets = [
      bucketRow({ ck: "big", observation_count: 30 }),
      bucketRow({
        ck: "small",
        observation_count: OUTLIER.minSampleSize - 1,
        raw_run_count: null,
      }),
    ];
    const result = await readGameDistribution(
      "cyberpunk-2077",
      baseQuery,
      fakeDb({
        game: GAME,
        buckets: [{ ...buckets[0], raw_run_count: 45 }, buckets[1]],
        summary: SUMMARY,
      }),
    );

    expect(result).not.toBeNull();
    expect(result!.cohorts).toHaveLength(2);
    const [big, small] = result!.cohorts;
    // ≥30 → a real distribution; <30 → cold start, no curve.
    expect(big!.distribution).not.toBeNull();
    expect(big!.distribution!.sampleCount).toBe(30);
    expect(small!.distribution).toBeNull();
    // Observation count is distinct from the raw run count behind it.
    expect(big!.observationCount).toBe(30);
    expect(big!.rawRunCount).toBe(45);
    // A bucket with no raw-count row falls back to its observation count.
    expect(small!.rawRunCount).toBe(OUTLIER.minSampleSize - 1);
  });

  it("computes the viewer's standing within its bucket", async () => {
    // 30 values 100..129; a viewer value of 120 sits at/above 21 of them → 70%.
    const buckets = [bucketRow({ ck: "ck-viewer" })];
    const result = await readGameDistribution(
      "cyberpunk-2077",
      { ...baseQuery, viewerRunId: "run-20" },
      fakeDb({
        game: GAME,
        viewer: [{ ck: "ck-viewer", value: 120 }],
        buckets,
        summary: SUMMARY,
      }),
    );
    expect(result!.cohorts[0]!.viewerPercentile).toBe(70);
    expect(result!.cohorts[0]!.viewerValue).toBe(120);
    expect(result!.cohorts[0]!.viewerExclusion).toBeNull();
  });

  it("inverts the standing on a lower-is-better metric", async () => {
    // Same 100..129 spread, but for frame-time p99 a value of 120 is at least as
    // good as the 10 values at/above it → 33%, not the raw 70% at-or-below.
    // A near-best frame time must never advertise itself as a high percentile.
    const result = await readGameDistribution(
      "cyberpunk-2077",
      { metric: "frametime-p99-ms", viewerRunId: "run-20" },
      fakeDb({
        game: GAME,
        viewer: [{ ck: "ck-viewer", value: 120 }],
        buckets: [bucketRow({ ck: "ck-viewer", viewer_at_or_worse: 10 })],
        summary: SUMMARY,
      }),
    );
    expect(result!.cohorts[0]!.viewerPercentile).toBe(33);
  });

  it("keeps the marker for a set member that is not its set's representative", async () => {
    // The viewer's run is eligible and in this bucket, but never appears in the
    // observation set — the case that silently lost its marker entirely.
    const result = await readGameDistribution(
      "cyberpunk-2077",
      { ...baseQuery, viewerRunId: "set-member-99" },
      fakeDb({
        game: GAME,
        viewer: [{ ck: "ck-viewer", value: 120 }],
        buckets: [bucketRow({ ck: "ck-viewer", viewer_is_observation: false })],
        summary: SUMMARY,
      }),
    );
    expect(result!.cohorts[0]!.viewerValue).toBe(120);
    expect(result!.cohorts[0]!.viewerExclusion).toBe("benchmark-set-member");
  });

  it("reports the viewer's run when it is the outlier dropped from the curve", async () => {
    // 29 tight values plus one far-out run that IS the viewer's.
    const result = await readGameDistribution(
      "cyberpunk-2077",
      { ...baseQuery, viewerRunId: "run-outlier" },
      fakeDb({
        game: GAME,
        viewer: [{ ck: "ck-viewer", value: 5_000 }],
        buckets: [
          bucketRow({
            ck: "ck-viewer",
            excluded_outlier_count: 1,
            viewer_is_outlier: true,
            viewer_at_or_worse: 29,
            sample_count: 29,
            max_value: 100,
            mean_value: 100,
            marker_p99: 100,
            bins: [{ lower: 100, upper: 100, count: 29 }],
          }),
        ],
        summary: SUMMARY,
      }),
    );
    const cohort = result!.cohorts[0]!;
    expect(cohort.excludedOutlierCount).toBe(1);
    expect(cohort.viewerExclusion).toBe("statistical-outlier");
    // Still ranked and still shown — excluded from the curve is not hidden.
    expect(cohort.viewerValue).toBe(5_000);
  });

  it("maps direction, version, and the exclusion summary", async () => {
    const result = await readGameDistribution(
      "cyberpunk-2077",
      { metric: "frametime-p99-ms" },
      fakeDb({ game: GAME, buckets: [], summary: SUMMARY }),
    );
    expect(result!.betterDirection).toBe("lower");
    expect(result!.cohortDefinitionVersion).toBe(2);
    expect(result!.minSampleSize).toBe(OUTLIER.minSampleSize);
    expect(result!.exclusionSummary).toEqual({
      aggregateEligibleRuns: 60,
      pooledObservations: 35,
      unprofiledRuns: 12,
      capabilityUnestablishedRuns: 3,
    });
  });

  it("reports diagnostic rates and marks a sensor-absent rate unavailable", async () => {
    const result = await readGameDistribution(
      "cyberpunk-2077",
      baseQuery,
      fakeDb({
        game: GAME,
        buckets: [],
        summary: SUMMARY,
        // 40 runs evaluated; 6 driver-outdated; VRAM telemetry present on 20 (4
        // flagged); no CPU/GPU util telemetry at all.
        rates: [
          {
            driver_denom: 40,
            driver_num: 6,
            vram_denom: 20,
            vram_num: 4,
            cpu_denom: 0,
            cpu_num: 0,
          },
        ],
      }),
    );
    const rates = result!.diagnosticRates;
    expect(rates.find((r) => r.key === "driver-currency")).toMatchObject({
      numerator: 6,
      denominator: 40,
      ratePct: 15,
    });
    expect(rates.find((r) => r.key === "vram-pressure")?.ratePct).toBe(20);
    // No util telemetry → unavailable, never a clean 0%.
    expect(rates.find((r) => r.key === "cpu-bound")).toMatchObject({
      denominator: 0,
      ratePct: null,
    });
  });

  it("flags truncation when more buckets exist than the cap returns", async () => {
    const buckets = Array.from({ length: 51 }, (_, i) =>
      bucketRow({ ck: `ck-${i}`, observation_count: 5 }),
    );
    const result = await readGameDistribution(
      "cyberpunk-2077",
      baseQuery,
      fakeDb({ game: GAME, buckets, summary: SUMMARY }),
    );
    expect(result!.truncated).toBe(true);
    expect(result!.cohorts).toHaveLength(50);
  });
});
