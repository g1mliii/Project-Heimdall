/**
 * Smoothness tiles (§13.2/§13.3): Avg / 1% low / 0.1% low on their tier
 * colors, plus the generated-frames share. `generatedFramePct` is a 0–1
 * fraction on the wire — the ×100 happens exactly once, here.
 */

import { Stat } from "@heimdall/ui";
import type { RunSummary } from "@heimdall/shared";

export function RunStatTiles({ summary }: { summary: RunSummary }) {
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "repeat(4, 1fr)",
        gap: "var(--space-4)",
        marginTop: "var(--space-6)",
      }}
    >
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
    </div>
  );
}
