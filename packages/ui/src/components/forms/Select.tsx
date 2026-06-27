"use client";

import * as React from "react";
import { cx } from "../../utils/cx";

export interface SelectOption {
  value: string;
  label: string;
}

export interface SelectProps extends React.SelectHTMLAttributes<HTMLSelectElement> {
  /** Field label. */
  label?: React.ReactNode;
  /** Helper text below the control. */
  hint?: React.ReactNode;
  /** Options as strings or {value,label}. Ignored if children are passed. */
  options?: (string | SelectOption)[];
}

/** Styled native select for hardware/game/resolution filters. */
export function Select({ label, hint, options = [], id, className = "", children, ...rest }: SelectProps) {
  const reactId = React.useId();
  const selId = id || (label ? reactId : undefined);
  return (
    <div className={cx("hd-field", className)}>
      {label && (
        <label className="hd-field__label" htmlFor={selId}>
          {label}
        </label>
      )}
      <span className="hd-select">
        <select id={selId} {...rest}>
          {children ||
            options.map((o) => {
              const value = typeof o === "string" ? o : o.value;
              const text = typeof o === "string" ? o : o.label;
              return (
                <option key={value} value={value}>
                  {text}
                </option>
              );
            })}
        </select>
        <span className="hd-select__chev" aria-hidden="true">
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="m6 9 6 6 6-6" />
          </svg>
        </span>
      </span>
      {hint && <span className="hd-field__hint">{hint}</span>}
    </div>
  );
}
