import Link from "next/link";
import { ButtonLink, Card } from "@heimdall/ui";
import { icon } from "@/components/icons";

const ChartIcon = icon(
  <g>
    <path d="M3 3v18h18" />
    <path d="m19 9-5 5-4-4-3 3" />
  </g>,
);
const GaugeIcon = icon(
  <g>
    <path d="M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z" />
    <path d="M12 15 15.5 9" />
    <path d="M4.5 15.5A9 9 0 1 1 8 19.9" />
  </g>,
);
const WrenchIcon = icon(
  <path d="M14.7 6.3a4 4 0 0 0-5.4 5.4l-6 6a2 2 0 0 0 2.8 2.8l6-6a4 4 0 0 0 5.4-5.4l-2.4 2.4-2.8-2.8Z" />,
);

const FEATURES = [
  {
    icon: ChartIcon,
    title: "Interactive frame-time chart",
    body: "Zoomable frame-by-frame trace with stutter spikes flagged automatically.",
  },
  {
    icon: GaugeIcon,
    title: "Smoothness tiers",
    body: "Avg, 1% low, and 0.1% low — the numbers that actually describe how a game feels.",
  },
  {
    icon: WrenchIcon,
    title: "Plain-English diagnostics",
    body: "\"RAM below rated speed — enable EXPO/XMP.\" Actionable, not just a chart.",
  },
];

export default function Home() {
  return (
    <main
      id="main-content"
      tabIndex={-1}
      style={{
        maxWidth: "var(--container-prose)",
        margin: "0 auto",
        padding: "var(--space-12) var(--space-6) var(--space-16)",
        display: "grid",
        gap: "var(--space-8)",
      }}
    >
      <header style={{ display: "grid", gap: "var(--space-3)" }}>
        <span className="heimdall-overline">Benchmarks</span>
        <h1 style={{ font: "var(--type-title)", color: "var(--fg-1)" }}>
          Is your PC running this game well?
        </h1>
        <p style={{ font: "var(--type-body)", color: "var(--fg-2)", maxWidth: "42rem" }}>
          Upload a CapFrameX, PresentMon, or MangoHud export and get a shareable interactive
          report: frame-time chart with stutter highlighting, smoothness tiers, hardware
          snapshot, and plain-English optimization advice. Parsed in your browser — no account
          needed.
        </p>
        <div style={{ display: "flex", gap: "var(--space-3)", marginTop: "var(--space-2)" }}>
          <ButtonLink as={Link} href="/upload" variant="primary">
            Upload a benchmark log
          </ButtonLink>
        </div>
        <p style={{ font: "var(--type-body-sm)", color: "var(--fg-3)" }}>
          Already have a report? Search for its game above once it&apos;s validated.
        </p>
      </header>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(15rem, 1fr))",
          gap: "var(--space-5)",
        }}
      >
        {FEATURES.map(({ icon: Icon, title, body }) => (
          <Card key={title}>
            <Card.Body>
              <Icon size={20} style={{ color: "var(--brand-teal)" }} />
              <h2
                style={{
                  font: "var(--type-subheading)",
                  color: "var(--fg-1)",
                  marginTop: "var(--space-3)",
                }}
              >
                {title}
              </h2>
              <p style={{ font: "var(--type-body-sm)", color: "var(--fg-2)", marginTop: "var(--space-2)" }}>
                {body}
              </p>
            </Card.Body>
          </Card>
        ))}
      </div>
    </main>
  );
}
