/**
 * Live frame-time readout for the capturing screen (§22.4).
 *
 * DISPLAY ONLY. This reads one column out of the streaming CSV so the chart and
 * the running FPS have something to draw; it is NOT a parser and its numbers
 * never reach the upload. The authoritative parse happens once on stop, through
 * `parseAnyCapture` — the same code the browser runs (§22.1) — and that is what
 * produces the summary, the capability manifest and the Parquet.
 *
 * Kept deliberately dumb for that reason: it recognizes the two frame-time
 * column names PresentMon emits and gives up quietly on anything else, leaving
 * the chart empty rather than inventing a shape.
 */

/** v2 emits `FrameTime`; v1 emitted `MsBetweenPresents`. */
const FRAME_TIME_COLUMNS = ["FrameTime", "MsBetweenPresents"];

/** Points retained for the sparkline. Older samples scroll off the left. */
export const LIVE_WINDOW = 600;

export class LiveFrameTimes {
  private column: number | null = null;
  private headerSeen = false;
  private readonly samples: number[] = [];
  private total = 0;
  private sum = 0;

  /** Feed rows exactly as they arrive from the sidecar, header included. */
  push(lines: readonly string[]): void {
    for (const line of lines) {
      if (!this.headerSeen) {
        this.headerSeen = true;
        const columns = line.split(",").map((value) => value.trim());
        const index = columns.findIndex((column) => FRAME_TIME_COLUMNS.includes(column));
        this.column = index >= 0 ? index : null;
        continue;
      }
      if (this.column === null) continue;
      const cell = line.split(",")[this.column];
      const value = cell === undefined ? Number.NaN : Number.parseFloat(cell);
      // A non-finite or non-positive frame time is a malformed row, not a
      // 0 ms frame; counting it would drag the running average to nonsense.
      if (!Number.isFinite(value) || value <= 0) continue;
      this.total += 1;
      this.sum += value;
      this.samples.push(value);
      if (this.samples.length > LIVE_WINDOW) this.samples.shift();
    }
  }

  /** Recent frame times, in milliseconds, oldest first. */
  window(): readonly number[] {
    return this.samples;
  }

  /** Frames with a usable frame time so far. */
  count(): number {
    return this.total;
  }

  /** Mean FPS over the whole capture, or `null` before the first frame. */
  averageFps(): number | null {
    if (this.total === 0 || this.sum <= 0) return null;
    return 1000 / (this.sum / this.total);
  }

  /** True when the header carried no frame-time column at all. */
  unreadable(): boolean {
    return this.headerSeen && this.column === null;
  }
}
