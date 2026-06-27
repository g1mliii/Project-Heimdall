import type * as React from "react";
import { cx } from "../../utils/cx";

export interface SegmentedOption {
  value: string;
  label: React.ReactNode;
  icon?: React.ReactNode;
}

export interface SegmentedProps extends Omit<React.HTMLAttributes<HTMLDivElement>, "onChange"> {
  /** Options as strings or {value,label,icon}. */
  options: (string | SegmentedOption)[];
  /** Currently selected value. */
  value: string;
  /** Called with the new value. */
  onChange?: (value: string) => void;
}

/** Compact segmented toggle for view modes (chart type, time window). */
export function Segmented({ options = [], value, onChange, className = "", ...rest }: SegmentedProps) {
  return (
    <div className={cx("hd-segmented", className)} role="group" {...rest}>
      {options.map((o) => {
        const v = typeof o === "string" ? o : o.value;
        const label = typeof o === "string" ? o : o.label;
        const icon = typeof o === "string" ? null : o.icon;
        return (
          <button
            key={v}
            type="button"
            className="hd-segmented__opt"
            aria-pressed={value === v}
            onClick={() => onChange && onChange(v)}
          >
            {icon}
            {label}
          </button>
        );
      })}
    </div>
  );
}
