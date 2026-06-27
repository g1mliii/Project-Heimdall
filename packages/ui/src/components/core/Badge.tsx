import type * as React from "react";

export interface BadgeProps extends React.HTMLAttributes<HTMLSpanElement> {
  /** Semantic tone. @default "neutral" */
  tone?: "neutral" | "good" | "warn" | "bad" | "info" | "brand" | "solid";
  /** Show a leading status dot. */
  dot?: boolean;
}

/** Compact uppercase status label (run status, smoothness verdict, etc.). */
export function Badge({ tone = "neutral", dot = false, className = "", children, ...rest }: BadgeProps) {
  const cls = ["hd-badge", `hd-badge--${tone}`, className].filter(Boolean).join(" ");
  return (
    <span className={cls} {...rest}>
      {dot && <span className="hd-badge__dot" aria-hidden="true" />}
      {children}
    </span>
  );
}
