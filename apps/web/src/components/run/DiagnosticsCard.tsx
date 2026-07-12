/**
 * Diagnostics panel placeholder (§13 right column). The rules engine is a
 * later phase — this card keeps the design layout honest ("coming soon", not
 * fake findings) and is replaced with real `Diagnostic` rows when the engine
 * lands. The visual baseline intentionally captures this stub.
 */

import { Badge, Card, Diagnostic } from "@heimdall/ui";

export function DiagnosticsCard() {
  return (
    <Card>
      <Card.Header title="Diagnostics" actions={<Badge tone="neutral">Coming soon</Badge>} />
      <Card.Body>
        <Diagnostic severity="info" title="Automated diagnostics are on the way">
          Future runs will be checked for VRAM saturation stutters, CPU bottlenecks, RAM below
          rated speed, and outdated GPU drivers — in plain English, with the fix named.
        </Diagnostic>
      </Card.Body>
    </Card>
  );
}
