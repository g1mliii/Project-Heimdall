import type * as React from "react";
import { cx } from "../../utils/cx";

export interface TooltipProps extends Omit<React.HTMLAttributes<HTMLSpanElement>, "content"> {
  /** Tooltip body shown above the trigger on hover/focus. */
  content: React.ReactNode;
}

/** Lightweight hover/focus tooltip for metric definitions and icon affordances. */
export function Tooltip({ content, className = "", children, ...rest }: TooltipProps) {
  return (
    <span className={cx("hd-tooltip", className)} tabIndex={0} {...rest}>
      {children}
      <span className="hd-tooltip__pop" role="tooltip">
        {content}
      </span>
    </span>
  );
}
