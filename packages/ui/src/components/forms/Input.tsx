"use client";

import * as React from "react";

export interface InputProps extends Omit<React.InputHTMLAttributes<HTMLInputElement>, "size"> {
  /** Field label rendered above the control. */
  label?: React.ReactNode;
  /** Helper text below the field. */
  hint?: React.ReactNode;
  /** Error message — overrides hint and applies the error style. */
  error?: React.ReactNode;
  /** Leading icon node. */
  icon?: React.ReactNode;
  /** Render the value in the mono face (for IDs, tokens, numbers). */
  mono?: boolean;
  /** Extra class on the wrapping field. */
  wrapClassName?: string;
}

/** Single-line text field with label, hint/error, and optional leading icon. */
export function Input({
  label,
  hint,
  error,
  icon,
  mono = false,
  id,
  className = "",
  wrapClassName = "",
  ...rest
}: InputProps) {
  const reactId = React.useId();
  const inputId = id || (label ? reactId : undefined);
  const input = (
    <input
      id={inputId}
      className={["hd-input", mono ? "hd-input--mono" : "", error ? "hd-input--error" : "", className]
        .filter(Boolean)
        .join(" ")}
      aria-invalid={error ? true : undefined}
      {...rest}
    />
  );
  return (
    <div className={["hd-field", wrapClassName].filter(Boolean).join(" ")}>
      {label && (
        <label className="hd-field__label" htmlFor={inputId}>
          {label}
        </label>
      )}
      {icon ? (
        <span className="hd-input__wrap">
          <span className="hd-input__icon">{icon}</span>
          {input}
        </span>
      ) : (
        input
      )}
      {(error || hint) && (
        <span className={`hd-field__hint${error ? " hd-field__hint--error" : ""}`}>{error || hint}</span>
      )}
    </div>
  );
}
