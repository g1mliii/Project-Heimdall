/**
 * Live frame-time readout for the capturing screen (§22.4).
 *
 * DISPLAY ONLY. This reads one column out of the streaming CSV so the chart and
 * the running FPS have something to draw; it is NOT a parser and its numbers
 * never reach the upload. The authoritative parse happens once on stop, through
 * `parseAnyCapture` — the same code the browser runs (§22.1) — and that is what
 * produces the summary, the capability manifest and the Parquet.
 *
 * Kept deliberately dumb for that reason: it finds the frame-time column and
 * gives up quietly on anything else, leaving the chart empty rather than
 * inventing a shape. The column aliases still come from @heimdall/parsers, so a
 * PresentMon rename is handled in one place rather than blanking this readout.
 */

import { FRAME_TIME_COLUMN_ALIASES } from "@heimdall/parsers";

/** Points retained for the sparkline. Older samples scroll off the left. */
export const LIVE_WINDOW = 600;

/**
 * Read the nth comma-separated cell without splitting the whole row.
 *
 * A capture row has ~24 columns and only one of them is wanted, so
 * `line.split(",")[n]` allocates 23 substrings per frame to throw them away —
 * at a few hundred frames a second that is the bulk of this class's cost.
 */
function cellAt(line: string, index: number): string | undefined {
  let start = 0;
  for (let column = 0; column < index; column += 1) {
    const comma = line.indexOf(",", start);
    if (comma === -1) return undefined;
    start = comma + 1;
  }
  const end = line.indexOf(",", start);
  return line.slice(start, end === -1 ? undefined : end);
}

export class LiveFrameTimes {
  private column: number | null = null;
  private headerSeen = false;
  /**
   * Fixed ring, not a growing array: the window is bounded, and `shift()` on a
   * full 600-entry array is an O(n) move on every frame.
   */
  private readonly ring = new Float64Array(LIVE_WINDOW);
  private filled = 0;
  private next = 0;
  private total = 0;
  private sum = 0;

  /** Feed rows exactly as they arrive from the sidecar, header included. */
  push(lines: readonly string[]): void {
    for (const line of lines) {
      if (!this.headerSeen) {
        this.headerSeen = true;
        // Lowercased, like the parser's own header matching: PresentMon's
        // capitalization has changed between builds.
        const columns = line.split(",").map((value) => value.trim().toLowerCase());
        const index = columns.findIndex((column) => FRAME_TIME_COLUMN_ALIASES.includes(column));
        this.column = index >= 0 ? index : null;
        continue;
      }
      if (this.column === null) continue;
      const cell = cellAt(line, this.column);
      const value = cell === undefined ? Number.NaN : Number.parseFloat(cell);
      // A non-finite or non-positive frame time is a malformed row, not a
      // 0 ms frame; counting it would drag the running average to nonsense.
      if (!Number.isFinite(value) || value <= 0) continue;
      this.total += 1;
      this.sum += value;
      this.ring[this.next] = value;
      this.next = (this.next + 1) % LIVE_WINDOW;
      if (this.filled < LIVE_WINDOW) this.filled += 1;
    }
  }

  /** Recent frame times, in milliseconds, oldest first. */
  window(): readonly number[] {
    const out = new Array<number>(this.filled);
    // Once the ring has wrapped, the oldest sample is the one about to be
    // overwritten.
    const oldest = this.filled < LIVE_WINDOW ? 0 : this.next;
    for (let i = 0; i < this.filled; i += 1) {
      out[i] = this.ring[(oldest + i) % LIVE_WINDOW]!;
    }
    return out;
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
