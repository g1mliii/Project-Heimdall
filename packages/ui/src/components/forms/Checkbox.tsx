"use client";

import * as React from "react";
import { cx } from "../../utils/cx";

export interface CheckboxProps extends Omit<React.InputHTMLAttributes<HTMLInputElement>, "type"> {
  /** Controlled checked state. */
  checked?: boolean;
  /** Change handler. */
  onChange?: React.ChangeEventHandler<HTMLInputElement>;
  /** Inline trailing label. */
  label?: React.ReactNode;
}

/** Checkbox for multi-select filters and consent toggles. */
export function Checkbox({ checked, onChange, label, id, disabled = false, className = "", ...rest }: CheckboxProps) {
  const reactId = React.useId();
  const cbId = id || reactId;
  return (
    <label className={cx("hd-check", className)} htmlFor={cbId}>
      <input id={cbId} type="checkbox" checked={checked} onChange={onChange} disabled={disabled} {...rest} />
      <span className="hd-check__box" aria-hidden="true">
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="3"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M20 6 9 17l-5-5" />
        </svg>
      </span>
      {label && <span>{label}</span>}
    </label>
  );
}
