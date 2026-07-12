/**
 * 404 for run URLs (§13.5). Deliberately generic: missing, private, flagged,
 * and hidden runs all land here, indistinguishably (same posture as the API).
 */

import Link from "next/link";
import { ButtonLink, Card } from "@heimdall/ui";

export default function RunNotFound() {
  return (
    <main
      id="main-content"
      tabIndex={-1}
      style={{
        maxWidth: "var(--container-prose)",
        margin: "0 auto",
        padding: "var(--space-16) var(--space-6)",
      }}
    >
      <Card>
        <Card.Body>
          <h1 style={{ font: "var(--type-heading)", color: "var(--fg-1)" }}>Run not found</h1>
          <p
            style={{
              font: "var(--type-body)",
              color: "var(--fg-2)",
              marginTop: "var(--space-2)",
            }}
          >
            This run doesn&apos;t exist, was deleted, or isn&apos;t visible from this link.
            Check the URL you were given.
          </p>
          <div style={{ marginTop: "var(--space-5)" }}>
            <ButtonLink as={Link} href="/upload" variant="primary">Upload a benchmark log</ButtonLink>
          </div>
        </Card.Body>
      </Card>
    </main>
  );
}
