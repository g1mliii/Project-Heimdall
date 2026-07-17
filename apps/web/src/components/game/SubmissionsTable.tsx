import Link from "next/link";
import type { GameSubmissionRow, GameSubmissionsQuery, SceneType } from "@heimdall/shared";
import {
  Badge,
  Button,
  Card,
  Diagnostic,
  Segmented,
  Spinner,
  Table,
  Tooltip,
  type TableColumn,
} from "@heimdall/ui";

import styles from "./GamePageClient.module.css";

const FRAME_GENERATION_LABELS: Record<GameSubmissionRow["methodology"]["frameGeneration"], string | null> = {
  none: null,
  unknown: "Frame gen",
  dlss3: "DLSS 3 frame gen",
  fsr3: "FSR 3 frame gen",
  xess: "XeSS frame gen",
};

const SCENE_LABELS: Record<NonNullable<GameSubmissionRow["sceneType"]>, string> = {
  "benchmark-scene": "Bench",
  gameplay: "Play",
  freeform: "Freeform",
};

const SUBMISSION_DATE_FORMATTER = new Intl.DateTimeFormat("en", {
  dateStyle: "medium",
  // Client Components render on the server before hydration. Fixing the
  // timezone makes this date deterministic across the server and browser.
  timeZone: "UTC",
});

/** Upscaler values that carry no methodology signal, so they are not shown. */
const HIDDEN_UPSCALERS = new Set(["none", "unknown"]);

function methodologyParts(row: GameSubmissionRow): string[] {
  const parts = [row.methodology.resolution, row.methodology.graphicsApi?.toUpperCase()].filter(
    (part): part is string => Boolean(part),
  );
  if (row.methodology.upscaler && !HIDDEN_UPSCALERS.has(row.methodology.upscaler)) {
    parts.push(row.methodology.upscaler.toUpperCase());
  }
  if (row.methodology.rayTracing === "on") parts.push("RT");
  const frameGeneration = FRAME_GENERATION_LABELS[row.methodology.frameGeneration];
  if (frameGeneration) parts.push(frameGeneration);
  return parts;
}

function DriverBadges({ row }: { row: GameSubmissionRow }) {
  if (!row.driverBelowMinimum && !row.driverBehindLatest) return null;

  return (
    <span className={styles.badgeRow}>
      {row.driverBelowMinimum && <Badge tone="warn">Driver below game minimum</Badge>}
      {row.driverBehindLatest && <Badge tone="neutral">Driver outdated</Badge>}
    </span>
  );
}

const columns: readonly TableColumn<GameSubmissionRow>[] = [
  {
    key: "gpu",
    header: "GPU",
    cell: (row) => (
      <span className={styles.cellStack}>
        <Link className={styles.runLink} href={`/runs/${encodeURIComponent(row.id)}`}>
          {row.gpu}
        </Link>
        <DriverBadges row={row} />
      </span>
    ),
  },
  { key: "cpu", header: "CPU", cell: (row) => row.cpu },
  {
    key: "scene",
    header: "Scene",
    cell: (row) =>
      row.sceneType ? (
        <Badge tone={row.sceneType === "benchmark-scene" ? "info" : "neutral"}>
          {SCENE_LABELS[row.sceneType]}
        </Badge>
      ) : (
        <span aria-label="Scene not declared">—</span>
      ),
  },
  {
    key: "methodology",
    header: "Methodology",
    cell: (row) => {
      const parts = methodologyParts(row);
      return (
        <span className={styles.cellStack}>
          {parts.length > 0 && <span>{parts.join(" · ")}</span>}
          <span className={styles.badgeRow}>
            {!row.methodology.profileComplete && <Badge tone="neutral">Profile incomplete</Badge>}
            {row.isWarmup && <Badge tone="warn">Warm-up</Badge>}
            {row.benchmarkSetId && (
              <Tooltip content="This run belongs to a repeatability set; no set statistics are pooled here.">
                <Badge tone="neutral">Set member</Badge>
              </Tooltip>
            )}
          </span>
        </span>
      );
    },
  },
  {
    key: "avg",
    header: "Avg",
    align: "right",
    numeric: true,
    cell: (row) => <strong className={styles.avgMetric}>{row.avgFps.toFixed(1)}</strong>,
  },
  {
    key: "p1",
    header: "1% Low",
    align: "right",
    numeric: true,
    cell: (row) => row.onePercentLowFps.toFixed(1),
  },
  {
    key: "p01",
    header: "0.1% Low",
    align: "right",
    numeric: true,
    cell: (row) => row.pointOnePercentLowFps.toFixed(1),
  },
  {
    key: "submitted",
    header: "Submitted",
    sortable: true,
    cell: (row) => (
      <span className={styles.cellStack}>
        <span>{row.submittedBy ?? "Anonymous"}</span>
        <time className={styles.submittedAt} dateTime={row.createdAt}>
          {SUBMISSION_DATE_FORMATTER.format(new Date(row.createdAt))}
        </time>
      </span>
    ),
  },
];

export type SceneFilter = "all" | SceneType;

export function SubmissionsTable({
  rows,
  sceneFilter,
  onSceneFilterChange,
  sortDirection,
  onSortDirectionChange,
  loading,
  error,
  canLoadMore,
  onLoadMore,
  onRetry,
}: {
  rows: readonly GameSubmissionRow[];
  sceneFilter: SceneFilter;
  onSceneFilterChange(value: SceneFilter): void;
  sortDirection: NonNullable<GameSubmissionsQuery["sortDirection"]>;
  onSortDirectionChange(value: NonNullable<GameSubmissionsQuery["sortDirection"]>): void;
  loading: boolean;
  error: string | null;
  canLoadMore: boolean;
  onLoadMore(): void;
  onRetry(): void;
}) {
  return (
    <Card className={styles.submissionsCard}>
      <Card.Header title="Submissions" actions={<Badge tone="neutral">{rows.length} shown</Badge>} />
      <div className={styles.tableToolbar}>
        <Segmented
          aria-label="Workload"
          value={sceneFilter}
          onChange={(value) => onSceneFilterChange(value as SceneFilter)}
          disabled={loading}
          options={[
            { value: "all", label: "All" },
            { value: "benchmark-scene", label: "Benchmark scene" },
            { value: "gameplay", label: "Gameplay" },
            { value: "freeform", label: "Freeform" },
          ]}
        />
        {loading && rows.length > 0 && <Spinner label="Loading submissions" />}
      </div>
      <Table
        caption="Individual public and validated game submissions"
        columns={columns}
        rows={rows}
        rowKey={(row) => row.id}
        sort={{ key: "submitted", direction: sortDirection }}
        onSortChange={(sort) => {
          if (sort.key === "submitted") onSortDirectionChange(sort.direction);
        }}
        empty={
          loading ? (
            <Spinner label="Loading submissions" />
          ) : (
            "No public, validated submissions match this view yet."
          )
        }
      />
      {(error || canLoadMore) && (
        <div className={styles.tableFooter}>
          {error ? (
            <Diagnostic severity="bad" title="Could not load submissions">
              <span>{error}</span>
              <Button className={styles.retryButton} variant="secondary" onClick={onRetry}>
                Retry
              </Button>
            </Diagnostic>
          ) : (
            <Button variant="secondary" loading={loading} onClick={onLoadMore}>
              Load more
            </Button>
          )}
        </div>
      )}
    </Card>
  );
}
