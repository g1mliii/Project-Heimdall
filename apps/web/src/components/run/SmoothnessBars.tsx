/**
 * Smoothness tier bars (§13.2) — production port of the design kit's
 * SmoothnessBars: Avg / 1% low / 0.1% low on the tier colors, with the
 * Phase 3 confidence label pinned to the 0.1% row. Confidence is graded by
 * sample count alone (POINT_ONE_PERCENT_LOW_CONFIDENCE_FRAMES), and the
 * pill says so honestly — short captures sample only a handful of worst
 * frames.
 */

import { Badge, Meter } from "@heimdall/ui";
import { POINT_ONE_PERCENT_LOW_CONFIDENCE_FRAMES } from "@heimdall/shared";
import type { RunSummary } from "@heimdall/shared";
import { formatCount } from "@/lib/format";
import { CAPTION_STYLE } from "../primitives";
import { CONFIDENCE_TONE } from "./confidence";

/**
 * The high-confidence threshold as text. The badge tooltip and the §8.6.6
 * visible caption both state the grading basis, so they read from this one
 * number rather than two hand-built sentences that drift apart.
 */
const HIGH_CONFIDENCE_FRAMES = formatCount(POINT_ONE_PERCENT_LOW_CONFIDENCE_FRAMES.high);

function confidenceTitle(summary: RunSummary, sampleCount: string): string {
  return (
    `Confidence: ${summary.pointOnePercentLowConfidence} — graded by sample count. ` +
    `${sampleCount} frames captured; ` +
    `0.1% lows need ${HIGH_CONFIDENCE_FRAMES}+ for high confidence.`
  );
}

export function SmoothnessBars({ summary }: { summary: RunSummary }) {
  const sampleCount = formatCount(summary.sampleCount);
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
        <Meter
          key={row.label}
          layout="inline"
          label={
            <>
              {row.label}
              {row.confidence && (
                <Badge
                  title={confidenceTitle(summary, sampleCount)}
                  tone={CONFIDENCE_TONE[row.confidence]}
                  dot
                >
                  {row.confidence}
                </Badge>
              )}
            </>
          }
          value={row.value}
          max={barMax}
          display={row.value.toFixed(1)}
          color={row.color}
        />
      ))}
      {/* §8.6.6 — the grading basis as visible text, not only a badge tooltip. */}
      <p style={CAPTION_STYLE}>
        Graded from <span data-mono>{sampleCount}</span> frames — 0.1% lows need{" "}
        <span data-mono>{HIGH_CONFIDENCE_FRAMES}</span>+ for high confidence.
      </p>
    </div>
  );
}
