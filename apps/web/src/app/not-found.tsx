/**
 * App-wide 404 — catches any URL that doesn't match a route (Next.js renders
 * this for the whole tree when no more specific `not-found.tsx` applies; see
 * `runs/[id]/not-found.tsx` for the run-scoped variant with its own copy).
 */

import Link from "next/link";
import { ButtonLink, Card } from "@heimdall/ui";

export default function NotFound() {
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
          <h1 style={{ font: "var(--type-heading)", color: "var(--fg-1)" }}>Page not found</h1>
          <p
            style={{
              font: "var(--type-body)",
              color: "var(--fg-2)",
              marginTop: "var(--space-2)",
            }}
          >
            That page doesn&apos;t exist. Check the URL, or head back to the benchmarks hub.
          </p>
          <div style={{ marginTop: "var(--space-5)", display: "flex", gap: "var(--space-3)" }}>
            <ButtonLink as={Link} href="/" variant="primary">Back to Benchmarks</ButtonLink>
            <ButtonLink as={Link} href="/upload" variant="secondary">Upload a benchmark log</ButtonLink>
          </div>
        </Card.Body>
      </Card>
    </main>
  );
}
