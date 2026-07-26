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
import { icon } from "@/components/icons";
import { CAPTION_STYLE, KeyValueRow } from "@/components/primitives";
import {
  HAGS_LABELS,
  MEDIUM_DATE_FORMATTER,
  UPSCALER_LABELS,
  framePacingParts,
  graphicsApiLabel,
} from "@/lib/format";

import styles from "./GamePageClient.module.css";

/** §20.3 verified-reviewer marker — matches the shield-check glyph in the design kit. */
const ShieldCheckIcon = icon(
  <g>
    <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Z" />
    <path d="m9 12 2 2 4-4" />
  </g>,
);

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

function methodologyParts(row: GameSubmissionRow): string[] {
  const { graphicsApi, upscaler } = row.methodology;
  const parts = [row.methodology.resolution, graphicsApi ? graphicsApiLabel(graphicsApi) : null]
    .filter((part): part is string => Boolean(part));
  // Shared with the run header via UPSCALER_LABELS: `null` is the no-signal set
  // ("none"/"unknown"), so both surfaces hide and case the same values.
  const upscalerLabel = upscaler ? UPSCALER_LABELS[upscaler] : null;
  if (upscalerLabel) parts.push(upscalerLabel);
  if (row.methodology.rayTracing === "on") parts.push("RT");
  const frameGeneration = FRAME_GENERATION_LABELS[row.methodology.frameGeneration];
  if (frameGeneration) parts.push(frameGeneration);
  return parts;
}

/**
 * §8.6.2 line 2 — declared settings + frame pacing. `null` means "not
 * declared" and is omitted entirely; a declared-off vsync/vrr renders as
 * "no VSync"/"no VRR" through the same `framePacingParts` the cohort selector
 * uses, so absence and a declared false never look the same and the two
 * surfaces can't word one pacing config two ways.
 */
function declaredParts(row: GameSubmissionRow): string[] {
  const m = row.methodology;
  const parts: string[] = [];
  if (m.settingsPreset !== null) parts.push(m.settingsPreset);
  if (m.scene !== null) parts.push(m.scene);
  parts.push(...framePacingParts(m));
  if (m.refreshHz !== null) parts.push(`${m.refreshHz} Hz`);
  return parts;
}

/** §8.6.2 low-frequency provenance facts, shown behind the info affordance. */
function declaredProfileEntries(row: GameSubmissionRow): Array<[string, string]> {
  const m = row.methodology;
  const entries: Array<[string, string]> = [];
  if (m.gameBuild !== null) entries.push(["Game build", m.gameBuild]);
  if (m.captureTool !== null) entries.push(["Capture tool", m.captureTool]);
  if (m.warmupPolicy !== null) entries.push(["Warm-up policy", m.warmupPolicy]);
  if (m.hags !== null) entries.push(["HAGS", HAGS_LABELS[m.hags]]);
  return entries;
}

const InfoIcon = icon(
  <g>
    <circle cx="12" cy="12" r="10" />
    <path d="M12 16v-4m0-4h.01" />
  </g>,
);

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
      const declared = declaredParts(row);
      const profile = declaredProfileEntries(row);
      return (
        <span className={styles.cellStack}>
          {parts.length > 0 && <span>{parts.join(" · ")}</span>}
          {/* §8.6.2 — declared settings + pacing; undeclared fields are
              omitted, never dashed out (the profile-incomplete badge already
              names the gap). */}
          {/* Plain inline flow, not inline-flex: the declared list wraps inside
              a narrow cell, and the info affordance has to trail the last word
              rather than float beside the first line. */}
          {(declared.length > 0 || profile.length > 0) && (
            <span style={CAPTION_STYLE}>
              {declared.join(" · ")}
              {profile.length > 0 && (
                <Tooltip
                  aria-label="Declared profile"
                  style={{ marginLeft: "var(--space-1)", verticalAlign: "middle" }}
                  content={
                    <span style={{ display: "flex", flexDirection: "column", gap: "var(--space-1)" }}>
                      {profile.map(([label, value]) => (
                        <KeyValueRow key={label} label={label} value={value} />
                      ))}
                    </span>
                  }
                >
                  <InfoIcon data-icon="declared-profile" size={12} style={{ color: "var(--fg-3)" }} />
                </Tooltip>
              )}
            </span>
          )}
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
        <span style={{ display: "inline-flex", alignItems: "center", gap: "var(--space-1)" }}>
          {row.submittedBy ?? "Anonymous"}
          {row.submittedByVerified && (
            <Tooltip content="Verified reviewer — hardware vetted by Heimdall">
              <ShieldCheckIcon data-icon="shield-check" size={14} style={{ color: "var(--brand-teal)" }} />
            </Tooltip>
          )}
        </span>
        <time className={styles.submittedAt} dateTime={row.createdAt}>
          {MEDIUM_DATE_FORMATTER.format(new Date(row.createdAt))}
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
