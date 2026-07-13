import { Badge, Card, Stat } from "@heimdall/ui";
import type { BenchmarkSetStats } from "@heimdall/parsers";
import { CONFIDENCE_LABEL, CONFIDENCE_TONE } from "./confidence";
import styles from "./RunPageClient.module.css";

function measuredRunsLabel(count: number): string {
  return `${count} measured ${count === 1 ? "run" : "runs"}`;
}

function warmupLabel(count: number): string {
  if (count === 0) return "No warm-up passes recorded";
  return `${count} warm-up ${count === 1 ? "pass" : "passes"} excluded`;
}

/** Repeatability context for a public benchmark-set member (§16c.2). */
export function BenchmarkSetCard({
  stats,
  currentRunIsWarmup,
}: {
  stats: BenchmarkSetStats;
  currentRunIsWarmup: boolean;
}) {
  const hasMeasuredRuns = stats.sampleCount > 0;
  const hasRepeatabilityEstimate = stats.sampleCount >= 2;

  return (
    <Card aria-label="Benchmark set repeatability">
      <Card.Header
        title="Benchmark set"
        actions={
          hasMeasuredRuns ? (
            <Badge tone={CONFIDENCE_TONE[stats.confidence]} dot>
              {CONFIDENCE_LABEL[stats.confidence]}
            </Badge>
          ) : undefined
        }
      />
      <Card.Body className={styles.benchmarkSetBody}>
        <p className={styles.benchmarkSetSummary}>
          {hasMeasuredRuns ? measuredRunsLabel(stats.sampleCount) : "No measured runs yet"}
          {" · "}
          {warmupLabel(stats.warmupRunCount)}
        </p>
        {hasRepeatabilityEstimate ? (
          <>
            <div className={styles.benchmarkSetStats}>
              <Stat
                label="Mean avg FPS"
                value={stats.meanAvgFps.toFixed(1)}
                unit="FPS"
                accent="var(--tier-avg)"
              />
              <Stat
                label="Relative variation (CV)"
                value={(stats.coefficientOfVariation * 100).toFixed(1)}
                unit="%"
                accent="var(--tier-p1)"
              />
            </div>
            <p className={styles.benchmarkSetNote}>
              Standard deviation ±{stats.stdDevAvgFps.toFixed(1)} FPS across{" "}
              {measuredRunsLabel(stats.sampleCount)}.
            </p>
          </>
        ) : hasMeasuredRuns ? (
          <p className={styles.benchmarkSetNote}>
            Add another measured run to estimate repeatability. A single pass cannot show spread.
          </p>
        ) : (
          <p className={styles.benchmarkSetNote}>
            Warm-up passes are retained but do not establish a benchmark result.
          </p>
        )}
        {currentRunIsWarmup && (
          <p className={styles.benchmarkSetNote}>
            This run is marked as a warm-up and is excluded from the statistics.
          </p>
        )}
      </Card.Body>
    </Card>
  );
}
