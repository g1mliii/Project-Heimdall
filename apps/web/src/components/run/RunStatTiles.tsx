/**
 * Smoothness tiles (§13.2/§13.3): Avg / 1% low / 0.1% low on their tier
 * colors, plus the generated-frames share. `generatedFramePct` is a 0–1
 * fraction on the wire — the ×100 happens exactly once, here.
 *
 * §8.6.3 adds the run's own tail-latency numbers (P95/P99 frame time, stutter
 * events) — previously these existed only as distribution-metric options on
 * the game page. Tier accents stay reserved for the FPS tiles.
 */

import { Stat } from "@heimdall/ui";
import type { RunSummary } from "@heimdall/shared";
import { formatCount } from "@/lib/format";
import styles from "./RunPageClient.module.css";

export function RunStatTiles({
  summary,
  interpolatedPresents,
}: {
  summary: RunSummary;
  /**
   * §22.12 — count of interpolated presents, supplied ONLY in rendered mode.
   *
   * When present it replaces the generated-frames tile. That swap is not
   * cosmetic: every sample in a rendered summary is by construction a rendered
   * interval, so `generatedFramePct` reads 0% for a run that is half generated
   * — re-manufacturing the exact false claim §22.11 removed. The honest count
   * lives on the analysis blob, so the tile reads from there instead.
   */
  interpolatedPresents?: number;
}) {
  return (
    <div className={styles.statTiles}>
      <Stat label="Avg FPS" value={summary.avgFps.toFixed(1)} accent="var(--tier-avg)" />
      <Stat label="1% low" value={summary.onePercentLowFps.toFixed(1)} accent="var(--tier-p1)" />
      <Stat
        label="0.1% low"
        value={summary.pointOnePercentLowFps.toFixed(1)}
        accent="var(--tier-p01)"
      />
      {interpolatedPresents === undefined ? (
        <Stat
          label="Generated frames"
          value={Math.round(summary.generatedFramePct * 100)}
          unit="%"
          accent="var(--brand-violet)"
        />
      ) : (
        <Stat
          label="Interpolated presents"
          value={formatCount(interpolatedPresents)}
          accent="var(--brand-violet)"
        />
      )}
      <Stat label="P95 frame time" value={summary.frameTimeP95Ms.toFixed(1)} unit="ms" />
      <Stat label="P99 frame time" value={summary.frameTimeP99Ms.toFixed(1)} unit="ms" />
      <Stat label="Stutter events" value={summary.stutterCount} />
    </div>
  );
}
