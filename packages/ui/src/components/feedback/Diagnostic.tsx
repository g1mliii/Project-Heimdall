import type * as React from "react";

const ICONS: Record<string, React.ReactNode> = {
  warn: <path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3M12 9v4m0 4h.01" />,
  bad: (
    <g>
      <circle cx="12" cy="12" r="10" />
      <path d="m15 9-6 6m0-6 6 6" />
    </g>
  ),
  good: (
    <g>
      <circle cx="12" cy="12" r="10" />
      <path d="m9 12 2 2 4-4" />
    </g>
  ),
  info: (
    <g>
      <circle cx="12" cy="12" r="10" />
      <path d="M12 16v-4m0-4h.01" />
    </g>
  ),
};

/**
 * Props for the auto-diagnostic callout.
 *
 * @startingPoint section="Feedback" subtitle="Auto-diagnostic advice callout" viewport="700x180"
 */
export interface DiagnosticProps extends Omit<React.HTMLAttributes<HTMLDivElement>, "title"> {
  /** Severity drives icon + color. @default "info" */
  severity?: "good" | "warn" | "bad" | "info";
  /** Bold one-line headline (the warning name). */
  title?: React.ReactNode;
}

/**
 * Auto-diagnostic callout — Heimdall's plain-English optimization advice.
 */
export function Diagnostic({ severity = "info", title, children, className = "", ...rest }: DiagnosticProps) {
  return (
    <div className={["hd-diag", `hd-diag--${severity}`, className].filter(Boolean).join(" ")} role="status" {...rest}>
      <span className="hd-diag__icon" aria-hidden="true">
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          {ICONS[severity] || ICONS.info}
        </svg>
      </span>
      <div className="hd-diag__body">
        {title && <span className="hd-diag__title">{title}</span>}
        {children && <span className="hd-diag__msg">{children}</span>}
      </div>
    </div>
  );
}
