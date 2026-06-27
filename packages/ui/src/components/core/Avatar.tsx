import type * as React from "react";
import { cx } from "../../utils/cx";

export interface AvatarProps extends React.HTMLAttributes<HTMLSpanElement> {
  /** Image URL; falls back to initials when absent. */
  src?: string;
  /** Full name — used for initials and img alt. */
  name?: string;
  /** @default "md" */
  size?: "sm" | "md" | "lg";
}

/** Circular user avatar (image or initials) for reviewer attribution. */
export function Avatar({ src, name = "", size = "md", className = "", ...rest }: AvatarProps) {
  const initials = name
    .split(" ")
    .map((w) => w[0])
    .filter(Boolean)
    .slice(0, 2)
    .join("")
    .toUpperCase();
  const cls = cx("hd-avatar", size !== "md" && `hd-avatar--${size}`, className);
  return (
    <span className={cls} {...rest}>
      {src ? <img src={src} alt={name} /> : initials || "?"}
    </span>
  );
}
