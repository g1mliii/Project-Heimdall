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
import styles from "./RunPageClient.module.css";

export function RunStatTiles({ summary }: { summary: RunSummary }) {
  return (
    <div className={styles.statTiles}>
      <Stat label="Avg FPS" value={summary.avgFps.toFixed(1)} accent="var(--tier-avg)" />
      <Stat label="1% low" value={summary.onePercentLowFps.toFixed(1)} accent="var(--tier-p1)" />
      <Stat
        label="0.1% low"
        value={summary.pointOnePercentLowFps.toFixed(1)}
        accent="var(--tier-p01)"
      />
      <Stat
        label="Generated frames"
        value={Math.round(summary.generatedFramePct * 100)}
        unit="%"
        accent="var(--brand-violet)"
      />
      <Stat label="P95 frame time" value={summary.frameTimeP95Ms.toFixed(1)} unit="ms" />
      <Stat label="P99 frame time" value={summary.frameTimeP99Ms.toFixed(1)} unit="ms" />
      <Stat label="Stutter events" value={summary.stutterCount} />
    </div>
  );
}
