/**
 * Smoothness tier bars (§13.2) — production port of the design kit's
 * SmoothnessBars: Avg / 1% low / 0.1% low on the tier colors, with the
 * Phase 3 confidence label pinned to the 0.1% row. Confidence is graded by
 * sample count alone (POINT_ONE_PERCENT_LOW_CONFIDENCE_FRAMES), and the
 * pill says so honestly — short captures sample only a handful of worst
 * frames.
 */

import { POINT_ONE_PERCENT_LOW_CONFIDENCE_FRAMES } from "@heimdall/shared";
import type { ConfidenceLevel, RunSummary } from "@heimdall/shared";

const CONFIDENCE_TONE: Record<ConfidenceLevel, string> = {
  low: "var(--warn)",
  medium: "var(--info)",
  high: "var(--good)",
};

function confidenceTitle(summary: RunSummary): string {
  const { high } = POINT_ONE_PERCENT_LOW_CONFIDENCE_FRAMES;
  return (
    `Confidence: ${summary.pointOnePercentLowConfidence} — graded by sample count. ` +
    `${summary.sampleCount.toLocaleString()} frames captured; ` +
    `0.1% lows need ${high.toLocaleString()}+ for high confidence.`
  );
}

export function SmoothnessBars({ summary }: { summary: RunSummary }) {
  // Nice headroom above the fastest tier so no bar renders 100% wide. Floor at
  // 10 so a degenerate 0-fps summary can't make every bar width NaN.
  const barMax = Math.max(10, Math.ceil((summary.avgFps * 1.1) / 10) * 10);
  const rows = [
    { label: "Avg FPS", value: summary.avgFps, color: "var(--tier-avg)" },
    { label: "1% low", value: summary.onePercentLowFps, color: "var(--tier-p1)" },
    {
      label: "0.1% low",
      value: summary.pointOnePercentLowFps,
      color: "var(--tier-p01)",
      confidence: summary.pointOnePercentLowConfidence,
    },
  ];

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-3)" }}>
      {rows.map((row) => (
        <div
          key={row.label}
          style={{
            display: "grid",
            gridTemplateColumns: "5rem 1fr 3.5rem",
            alignItems: "center",
            gap: "var(--space-3)",
          }}
        >
          <span
            className="hd-meter__label"
            style={{ display: "inline-flex", alignItems: "center", gap: "var(--space-1)" }}
          >
            {row.label}
            {row.confidence && (
              <span
                title={confidenceTitle(summary)}
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 3,
                  font: "var(--type-overline)",
                  color: CONFIDENCE_TONE[row.confidence],
                  textTransform: "uppercase",
                  letterSpacing: "0.06em",
                  borderWidth: "var(--border-thin)",
                  borderStyle: "solid",
                  borderColor: CONFIDENCE_TONE[row.confidence],
                  borderRadius: 2,
                  paddingLeft: 4,
                  paddingRight: 4,
                  height: 14,
                }}
              >
                <span
                  style={{
                    width: 4,
                    height: 4,
                    borderRadius: "var(--radius-pill)",
                    background: "currentColor",
                  }}
                />
                {row.confidence}
              </span>
            )}
          </span>
          <div
            style={{
              height: 14,
              background: "var(--bg-inset)",
              borderRadius: "var(--radius-pill)",
              overflow: "hidden",
            }}
          >
            <div
              style={{
                width: `${Math.min(100, (row.value / barMax) * 100)}%`,
                height: "100%",
                background: row.color,
                borderRadius: "var(--radius-pill)",
              }}
            />
          </div>
          <span
            data-mono
            style={{ font: "var(--type-data)", color: "var(--fg-1)", textAlign: "right" }}
          >
            {row.value.toFixed(1)}
          </span>
        </div>
      ))}
    </div>
  );
}
