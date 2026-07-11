import type * as React from "react";
import { cx } from "../../utils/cx";

/**
 * Props for the primary call-to-action button.
 *
 * @startingPoint section="Core" subtitle="Buttons in every variant & size" viewport="700x200"
 */
export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  /** Visual style. @default "primary" */
  variant?: "primary" | "secondary" | "ghost" | "subtle" | "danger";
  /** Control height. @default "md" */
  size?: "sm" | "md" | "lg";
  /** Stretch to fill the container width. */
  block?: boolean;
  /** Show a spinner and disable interaction. */
  loading?: boolean;
  /** Leading icon node (e.g. a Lucide <i> or inline SVG). */
  iconLeft?: React.ReactNode;
  /** Trailing icon node. */
  iconRight?: React.ReactNode;
}

/**
 * Heimdall primary action button. Thin wrapper over the .hd-btn classes.
 */
export function Button({
  variant = "primary",
  size = "md",
  block = false,
  loading = false,
  disabled = false,
  iconLeft = null,
  iconRight = null,
  type = "button",
  className = "",
  children,
  ...rest
}: ButtonProps) {
  const cls = cx(
    "hd-btn",
    `hd-btn--${variant}`,
    size !== "md" && `hd-btn--${size}`,
    block && "hd-btn--block",
    className,
  );

  return (
    <button type={type} className={cls} disabled={disabled || loading} {...rest}>
      {loading ? <span className="hd-spinner" aria-hidden="true" /> : iconLeft}
      {children != null && <span>{children}</span>}
      {!loading && iconRight}
    </button>
  );
}
