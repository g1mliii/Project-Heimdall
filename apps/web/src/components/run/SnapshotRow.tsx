/**
 * Key/value hairline row shared by the hardware snapshot (§13.4) and the
 * capture-capability panel (§8.6.1) — the design kit's SnapshotRow.
 */

import type * as React from "react";
import { TriangleAlertIcon } from "./icons";

export function SnapshotRow({
  k,
  v,
  warn,
  mono = true,
}: {
  k: string;
  v: React.ReactNode;
  warn?: boolean;
  /**
   * The value slot's default is the `data-mono` / `--type-data` numeric slot.
   * Set false when the value carries its own type and color — a coverage badge
   * is not a numeric — so the row chrome stays shared either way.
   */
  mono?: boolean;
}) {
  return (
    <div
      style={{
        display: "flex",
        justifyContent: "space-between",
        alignItems: "center",
        paddingTop: "var(--space-2)",
        paddingBottom: "var(--space-2)",
        borderBottomWidth: "var(--border-thin)",
        borderBottomStyle: "solid",
        borderBottomColor: "var(--line-1)",
      }}
    >
      <span style={{ font: "var(--type-body-sm)", color: "var(--fg-3)" }}>{k}</span>
      <span
        data-mono={mono ? "" : undefined}
        style={{
          ...(mono ? { font: "var(--type-data)", color: warn ? "var(--warn)" : "var(--fg-1)" } : {}),
          display: "inline-flex",
          minWidth: 0,
          alignItems: "center",
          gap: "var(--space-1)",
          overflowWrap: "anywhere",
          textAlign: "right",
        }}
      >
        {warn && <TriangleAlertIcon size={13} style={{ color: "var(--warn)" }} />}
        {v}
      </span>
    </div>
  );
}
