"use client";

/**
 * Route-level error boundary for the run report (§13.5) — a DB outage or
 * render fault lands here instead of a blank screen.
 */

import { Button, Card, Diagnostic } from "@heimdall/ui";

export default function RunError({ reset }: { error: Error; reset: () => void }) {
  return (
    <div
      style={{
        maxWidth: "var(--container-prose)",
        margin: "0 auto",
        padding: "var(--space-16) var(--space-6)",
      }}
    >
      <Card>
        <Card.Body>
          <Diagnostic severity="bad" title="Something went wrong loading this run">
            <span>The report couldn&apos;t be rendered. Your data is safe — try again.</span>
            <span style={{ display: "block", marginTop: "var(--space-3)" }}>
              <Button variant="secondary" onClick={() => reset()}>
                Try again
              </Button>
            </span>
          </Diagnostic>
        </Card.Body>
      </Card>
    </div>
  );
}
