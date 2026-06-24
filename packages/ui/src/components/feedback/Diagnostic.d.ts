import React from 'react';

/**
 * Props for the auto-diagnostic callout.
 *
 * @startingPoint section="Feedback" subtitle="Auto-diagnostic advice callout" viewport="700x180"
 */
export interface DiagnosticProps extends React.HTMLAttributes<HTMLDivElement> {
  /** Severity drives icon + color. @default "info" */
  severity?: 'good' | 'warn' | 'bad' | 'info';
  /** Bold one-line headline (the warning name). */
  title?: React.ReactNode;
}

/**
 * Auto-diagnostic callout — Heimdall's plain-English optimization advice.
 */
export function Diagnostic(props: DiagnosticProps): JSX.Element;
