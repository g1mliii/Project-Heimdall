import type * as React from "react";
import { cx } from "../../utils/cx";

export interface TabItem {
  value: string;
  label: React.ReactNode;
  icon?: React.ReactNode;
}

export interface TabsProps extends Omit<React.HTMLAttributes<HTMLDivElement>, "onChange"> {
  /** Tabs as strings or {value,label,icon}. */
  tabs: (string | TabItem)[];
  /** Active tab value. */
  value: string;
  /** Called with the new active value. */
  onChange?: (value: string) => void;
}

/** Underlined tab bar for run-page sections and dashboard views. */
export function Tabs({ tabs = [], value, onChange, className = "", ...rest }: TabsProps) {
  return (
    <div className={cx("hd-tabs", className)} role="tablist" {...rest}>
      {tabs.map((t) => {
        const v = typeof t === "string" ? t : t.value;
        const label = typeof t === "string" ? t : t.label;
        const icon = typeof t === "string" ? null : t.icon;
        const active = value === v;
        return (
          <button
            key={v}
            type="button"
            role="tab"
            aria-selected={active}
            className={`hd-tab${active ? " hd-tab--active" : ""}`}
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
