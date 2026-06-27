import type * as React from "react";
import { cx } from "../../utils/cx";

export interface SpinnerProps extends React.HTMLAttributes<HTMLSpanElement> {
  /** Diameter in px. @default 18 */
  size?: number;
  /** Optional trailing label text. */
  label?: React.ReactNode;
}

/** Indeterminate loading spinner for parse/upload/processing states. */
export function Spinner({ size = 18, label, className = "", ...rest }: SpinnerProps) {
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: "var(--space-2)" }} {...rest}>
      <span
        className={cx("hd-spinner", className)}
        style={{ width: size, height: size }}
        role="status"
        aria-label={typeof label === "string" ? label : "Loading"}
      />
      {label && <span style={{ font: "var(--type-body-sm)", color: "var(--fg-3)" }}>{label}</span>}
    </span>
  );
}
