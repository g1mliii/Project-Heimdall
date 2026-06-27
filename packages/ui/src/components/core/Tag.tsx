import type * as React from "react";

export interface TagProps extends React.HTMLAttributes<HTMLSpanElement> {
  /** When provided, renders a dismiss affordance and calls this on remove. */
  onRemove?: (e: React.SyntheticEvent) => void;
}

/** Dismissible chip — filters, selected hardware, applied settings. */
export function Tag({ onRemove, className = "", children, ...rest }: TagProps) {
  return (
    <span className={["hd-tag", className].filter(Boolean).join(" ")} {...rest}>
      {children}
      {onRemove && (
        <span
          className="hd-tag__close"
          role="button"
          tabIndex={0}
          aria-label="Remove"
          onClick={onRemove}
          onKeyDown={(e: React.KeyboardEvent) => {
            if (e.key === "Enter" || e.key === " ") onRemove(e);
          }}
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round">
            <path d="M18 6 6 18M6 6l12 12" />
          </svg>
        </span>
      )}
    </span>
  );
}
