"use client";

import * as React from "react";
import { cx } from "../../utils/cx";

export interface SwitchProps extends Omit<React.InputHTMLAttributes<HTMLInputElement>, "type"> {
  /** Controlled checked state. */
  checked?: boolean;
  /** Change handler. */
  onChange?: React.ChangeEventHandler<HTMLInputElement>;
  /** Inline trailing label. */
  label?: React.ReactNode;
}

/** Binary toggle — e.g. "Verified only" vs "All submissions". */
export function Switch({ checked, onChange, label, id, disabled = false, className = "", ...rest }: SwitchProps) {
  const reactId = React.useId();
  const swId = id || reactId;
  return (
    <label className={cx("hd-switch", className)} htmlFor={swId}>
      <input
        id={swId}
        type="checkbox"
        role="switch"
        checked={checked}
        onChange={onChange}
        disabled={disabled}
        {...rest}
      />
      <span className="hd-switch__track">
        <span className="hd-switch__thumb" />
      </span>
      {label && <span className="hd-switch__label">{label}</span>}
    </label>
  );
}
