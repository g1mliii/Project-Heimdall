/**
 * App-level shapes that recur across screens but are too app-specific to live
 * in `@heimdall/ui` (which owns the design system's real primitives).
 *
 * Both entries here exist because the same literal was being retyped per
 * screen: a caption's type/color pair, and the label/value row the evidence
 * disclosure and the declared-profile tooltip both draw. Tokens only — never a
 * raw hex or px.
 */

import type * as React from "react";

/** The caption slot: secondary type, tertiary foreground. */
export const CAPTION_STYLE = {
  font: "var(--type-caption)",
  color: "var(--fg-3)",
} as const satisfies React.CSSProperties;

/**
 * Label on the left, value on the right, baseline-aligned. Numerics get the
 * tabular `data-mono` slot per the UI convention.
 */
export function KeyValueRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div
      style={{
        display: "flex",
        justifyContent: "space-between",
        alignItems: "baseline",
        gap: "var(--space-3)",
      }}
    >
      <span style={CAPTION_STYLE}>{label}</span>
      <span data-mono style={{ font: "var(--type-caption)", color: "var(--fg-2)" }}>
        {value}
      </span>
    </div>
  );
}
