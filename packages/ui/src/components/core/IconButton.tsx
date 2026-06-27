import type * as React from "react";

export interface IconButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  /** Control size. @default "md" */
  size?: "sm" | "md" | "lg";
  /** Render with a filled surface + border instead of transparent. */
  solid?: boolean;
  /** Accessible label — required for icon-only controls. */
  "aria-label": string;
}

/** Compact icon-only button for toolbars and dense rows. */
export function IconButton({
  size = "md",
  solid = false,
  disabled = false,
  className = "",
  children,
  ...rest
}: IconButtonProps) {
  const cls = [
    "hd-iconbtn",
    size !== "md" ? `hd-iconbtn--${size}` : "",
    solid ? "hd-iconbtn--solid" : "",
    className,
  ]
    .filter(Boolean)
    .join(" ");
  return (
    <button type="button" className={cls} disabled={disabled} {...rest}>
      {children}
    </button>
  );
}
