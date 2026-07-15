/**
 * Diagnostics panel (§13 right column). Renders the Phase 6 rules-engine
 * findings as plain-English `Diagnostic` callouts with the fix named, and drives
 * the header badge off the count. A clean run shows an explicit "no issues"
 * pass — but ONLY once the run is verified: diagnostics are written by the
 * verification worker, so a not-yet-verified run has an empty array that must
 * read as "pending", never as a green all-clear (design/ui_kits/web/RunPage.jsx).
 *
 * Only `warn`/`bad` findings are issues. The §16b attribution rules always emit
 * an `info` finding (a healthy run still gets "Likely GPU-bound"), so counting
 * every finding would badge every capture carrying busy-time telemetry as having
 * an issue and make the all-clear unreachable.
 */

import type * as React from "react";
import { Badge, Card, Diagnostic } from "@heimdall/ui";
import { RUN_STATUS, type Diagnostic as DiagnosticData, type RunStatus } from "@heimdall/shared";

export function DiagnosticsCard({
  diagnostics,
  status,
}: {
  diagnostics: DiagnosticData[];
  status: RunStatus;
}) {
  // Diagnostics land atomically with the verification verdict; a still-pending
  // run has run no checks yet, so an empty array there means "not run", not "clean".
  const verified = status === RUN_STATUS.validated || status === RUN_STATUS.flagged;
  const issueCount = diagnostics.filter(
    (diagnostic) => diagnostic.severity === "warn" || diagnostic.severity === "bad",
  ).length;

  let badge: React.ReactNode;
  if (!verified) badge = <Badge tone="neutral">Pending</Badge>;
  else if (issueCount > 0)
    badge = (
      <Badge tone="warn">
        {issueCount} issue{issueCount === 1 ? "" : "s"}
      </Badge>
    );
  else badge = <Badge tone="good">No issues</Badge>;

  return (
    <Card>
      <Card.Header title="Diagnostics" actions={badge} />
      <Card.Body>
        <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-3)" }}>
          {!verified ? (
            <Diagnostic severity="info" title="Diagnostics run after verification">
              Automated checks for VRAM saturation, CPU bottlenecks, RAM below rated speed, and
              outdated GPU drivers run once this run finishes verifying.
            </Diagnostic>
          ) : (
            <>
              {issueCount === 0 ? (
                <Diagnostic severity="good" title="No issues detected">
                  Heimdall checked this run for VRAM saturation, CPU bottlenecks, RAM below rated
                  speed, and outdated GPU drivers — nothing to flag.
                </Diagnostic>
              ) : null}
              {diagnostics.map((diagnostic) => (
                <Diagnostic
                  key={diagnostic.id}
                  severity={diagnostic.severity}
                  title={diagnostic.title}
                >
                  {diagnostic.confidence ? `${diagnostic.confidence} confidence — ` : ""}
                  {diagnostic.detail}
                </Diagnostic>
              ))}
            </>
          )}
        </div>
      </Card.Body>
    </Card>
  );
}
