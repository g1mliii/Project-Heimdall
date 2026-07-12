import { Badge, Button, Card, Stat } from "@heimdall/ui";

/**
 * Throwaway Phase 1 page: proves @heimdall/ui primitives render on the dark
 * canvas with the design tokens wired. Replaced by the real dashboard in Phase 5.
 */
export default function Home() {
  return (
    <main
      id="main-content"
      tabIndex={-1}
      style={{
        maxWidth: "var(--container-prose)",
        margin: "0 auto",
        padding: "var(--space-12) var(--space-6)",
        display: "grid",
        gap: "var(--space-6)",
      }}
    >
      <header style={{ display: "grid", gap: "var(--space-2)" }}>
        <span className="heimdall-overline">Phase 1</span>
        <h1>Heimdall design system is wired</h1>
        <p style={{ color: "var(--fg-2)" }}>
          The dark instrument canvas, tokens, fonts, and @heimdall/ui primitives all render from one source.
        </p>
      </header>

      <Card>
        <Card.Header title="Primitives" actions={<Badge tone="good">live</Badge>} />
        <Card.Body>
          <div style={{ display: "flex", flexWrap: "wrap", gap: "var(--space-3)", alignItems: "center" }}>
            <Button variant="primary">Primary</Button>
            <Button variant="secondary">Secondary</Button>
            <Button variant="ghost">Ghost</Button>
          </div>
        </Card.Body>
      </Card>

      <Card>
        <Card.Header title="Metrics render in the mono face" />
        <Card.Body>
          <div style={{ display: "flex", flexWrap: "wrap", gap: "var(--space-8)" }}>
            <Stat label="Avg FPS" value="119.8" unit="fps" />
            <Stat label="1% low" value="96.2" unit="fps" />
            <Stat label="0.1% low" value="78.4" unit="fps" />
          </div>
        </Card.Body>
      </Card>
    </main>
  );
}
