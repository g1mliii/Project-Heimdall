import type * as React from "react";
import { cx } from "../../utils/cx";

/**
 * Props for the primary call-to-action button.
 *
 * @startingPoint section="Core" subtitle="Buttons in every variant & size" viewport="700x200"
 */
interface ButtonVisualProps {
  /** Visual style. @default "primary" */
  variant?: "primary" | "secondary" | "ghost" | "subtle" | "danger";
  /** Control height. @default "md" */
  size?: "sm" | "md" | "lg";
  /** Stretch to fill the container width. */
  block?: boolean;
  /** Leading icon node (e.g. a Lucide <i> or inline SVG). */
  iconLeft?: React.ReactNode;
  /** Trailing icon node. */
  iconRight?: React.ReactNode;
}

export interface ButtonProps extends ButtonVisualProps, React.ButtonHTMLAttributes<HTMLButtonElement> {
  /** Show a spinner and disable interaction. */
  loading?: boolean;
}

/** Link-shaped navigation using the same visual button primitive. */
export type ButtonLinkProps = ButtonVisualProps &
  Omit<React.AnchorHTMLAttributes<HTMLAnchorElement>, "href"> & {
    href: string;
    as?: React.ElementType;
  };

function buttonClassName(
  variant: NonNullable<ButtonProps["variant"]>,
  size: NonNullable<ButtonProps["size"]>,
  block: boolean,
  className: string,
) {
  return cx(
    "hd-btn",
    `hd-btn--${variant}`,
    size !== "md" && `hd-btn--${size}`,
    block && "hd-btn--block",
    className,
  );
}

function ButtonContents({
  loading = false,
  iconLeft = null,
  iconRight = null,
  children,
}: Pick<ButtonProps, "loading" | "iconLeft" | "iconRight" | "children">) {
  return (
    <>
      {loading ? <span className="hd-spinner" aria-hidden="true" /> : iconLeft}
      {children != null && <span>{children}</span>}
      {!loading && iconRight}
    </>
  );
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
  const cls = buttonClassName(variant, size, block, className);

  return (
    <button type={type} className={cls} disabled={disabled || loading} {...rest}>
      <ButtonContents loading={loading} iconLeft={iconLeft} iconRight={iconRight}>
        {children}
      </ButtonContents>
    </button>
  );
}

export function ButtonLink({
  variant = "primary",
  size = "md",
  block = false,
  iconLeft = null,
  iconRight = null,
  className = "",
  style,
  children,
  as: Component = "a",
  ...rest
}: ButtonLinkProps) {
  return (
    <Component className={buttonClassName(variant, size, block, className)} style={{ textDecoration: "none", ...style }} {...rest}>
      <ButtonContents iconLeft={iconLeft} iconRight={iconRight}>{children}</ButtonContents>
    </Component>
  );
}
