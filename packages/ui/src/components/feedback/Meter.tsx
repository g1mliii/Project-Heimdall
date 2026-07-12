import { useId } from "react";
import type * as React from "react";
import { cx } from "../../utils/cx";

export interface MeterProps extends React.HTMLAttributes<HTMLDivElement> {
  /** Uppercase overline label. */
  label?: React.ReactNode;
  /** Current value. */
  value?: number;
  /** Maximum value. @default 100 */
  max?: number;
  /** Formatted value text shown on the right (e.g. "92%", "11.4 GB"). */
  display?: React.ReactNode;
  /** Fill color (CSS value) — use a semantic/tier token. @default teal */
  color?: string;
  /** Compact label → track → value layout for metric comparisons. */
  layout?: "stacked" | "inline";
}

/** Horizontal utilization/progress meter for GPU load, VRAM, upload progress. */
export function Meter({
  label,
  value = 0,
  max = 100,
  display,
  color = "var(--brand-teal)",
  layout = "stacked",
  className = "",
  ...rest
}: MeterProps) {
  const pct = max > 0 ? Math.max(0, Math.min(100, (value / max) * 100)) : 0;
  const labelId = useId();
  const valueText = typeof display === "string" || typeof display === "number" ? String(display) : undefined;
  const track = (
    <div
      className="hd-meter__track"
      role="progressbar"
      aria-labelledby={label ? labelId : undefined}
      aria-valuenow={value}
      aria-valuemin={0}
      aria-valuemax={max}
      aria-valuetext={valueText}
    >
      <div className="hd-meter__fill" style={{ width: `${pct}%`, background: color }} />
    </div>
  );

  if (layout === "inline") {
    return (
      <div className={cx("hd-meter", "hd-meter--inline", className)} {...rest}>
        {label && <span id={labelId} className="hd-meter__label">{label}</span>}
        {track}
        {display !== undefined && <span className="hd-meter__value">{display}</span>}
      </div>
    );
  }

  return (
    <div className={cx("hd-meter", className)} {...rest}>
      {(label || display !== undefined) && (
        <div className="hd-meter__head">
          {label && <span id={labelId} className="hd-meter__label">{label}</span>}
          {display !== undefined && <span className="hd-meter__value">{display}</span>}
        </div>
      )}
      {track}
    </div>
  );
}
