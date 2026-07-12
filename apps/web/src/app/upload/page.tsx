import type { Metadata } from "next";
import { UploadClient } from "@/components/upload/UploadClient";

export const metadata: Metadata = {
  title: "Upload a benchmark log — Heimdall",
  description:
    "Drag a CapFrameX, PresentMon, or MangoHud export. Parsed in your browser — no account needed.",
};

export default function UploadPage() {
  return (
    <main
      id="main-content"
      tabIndex={-1}
      style={{
        maxWidth: "var(--container-prose)",
        margin: "0 auto",
        padding: "var(--space-12) var(--space-6) var(--space-16)",
      }}
    >
      <span className="heimdall-overline">Ingest</span>
      <h1 style={{ font: "var(--type-title)", color: "var(--fg-1)", marginTop: "var(--space-1)" }}>
        Upload a benchmark log
      </h1>
      <p style={{ font: "var(--type-body)", color: "var(--fg-2)", marginTop: "var(--space-2)", marginBottom: "var(--space-6)" }}>
        Drag a CapFrameX, PresentMon, or MangoHud export. We parse it in your browser — no
        account needed.
      </p>
      <UploadClient />
    </main>
  );
}
