/**
 * /privacy (§20.4) — plain-English privacy policy. Content mirrors the
 * load-bearing rules in docs/integrity-and-privacy.md; keep the two in sync
 * if either changes. Extended again in Phase 12 for analytics retention.
 */

import type { Metadata } from "next";
import type { ReactNode } from "react";
import { Card } from "@heimdall/ui";

export const metadata: Metadata = {
  title: "Privacy — Heimdall",
};

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <Card style={{ marginTop: "var(--space-5)" }}>
      <Card.Header title={title} />
      <Card.Body style={{ display: "grid", gap: "var(--space-3)" }}>{children}</Card.Body>
    </Card>
  );
}

function P({ children }: { children: ReactNode }) {
  return <p style={{ font: "var(--type-body)", color: "var(--fg-2)" }}>{children}</p>;
}

export default function PrivacyPage() {
  return (
    <main
      id="main-content"
      tabIndex={-1}
      style={{
        maxWidth: "var(--container-prose)",
        margin: "0 auto",
        padding: "var(--space-8) var(--space-6) var(--space-16)",
      }}
    >
      <span className="heimdall-overline">Privacy</span>
      <h1 style={{ font: "var(--type-title)", color: "var(--fg-1)", marginTop: "var(--space-1)" }}>
        What we collect, and how to remove it
      </h1>
      <P>
        Heimdall is built to work anonymously by default. This page explains exactly what&apos;s
        collected either way, and how to delete it.
      </P>

      <Section title="Hardware snapshot — quasi-identifying data">
        <P>
          Every run carries a hardware/software snapshot: GPU, CPU, RAM configuration, driver
          version, OS, resolution, and available sensor telemetry. In combination, this is a{" "}
          <strong>quasi-identifying hardware fingerprint</strong> — not anonymous data, even
          though it names no person. We collect it because the diagnostics engine needs it to
          explain why a run performs the way it does.
        </P>
        <P>
          It follows the run through every deletion path: deleting a run removes its snapshot;
          deleting an account removes every run&apos;s snapshot along with it. Aggregate pages
          group on canonical hardware/game ids, never raw display strings.
        </P>
      </Section>

      <Section title="Account data">
        <P>
          If you sign in, your email and display handle are managed by Clerk, our auth provider.
          We store your Clerk user id, handle, email, and role (public/verified/admin) — nothing
          else. Signing in is optional: anonymous uploads work with no account and no login wall.
        </P>
      </Section>

      <Section title="Management tokens are hashed, never stored in plain text">
        <P>
          An anonymous upload gets a one-time plaintext management/delete token, shown{" "}
          <strong>once</strong>. We store only its SHA-256 hash, compared in constant time. A
          database leak alone cannot be used to delete or manage a run — the plaintext isn&apos;t
          there to steal.
        </P>
      </Section>

      <Section title="Visibility">
        <P>
          <strong>Private</strong> runs are owner-only — a logged-out stranger gets a 404, the same
          response as a run that doesn&apos;t exist. <strong>Unlisted</strong> runs are reachable
          only via their unguessable link. <strong>Public</strong> runs are discoverable, and only
          feed aggregate averages once server-verified. Private and unlisted runs never enter an
          aggregate, even when their direct link is known.
        </P>
      </Section>

      <Section title="Deleting a run">
        <P>
          The run&apos;s owner (or anyone holding its management token) can delete it at any time —
          from the run page or your account&apos;s &quot;My runs&quot; list. Deletion removes both
          the database row and its stored frame data in object storage; nothing is left behind.
        </P>
      </Section>

      <Section title="Deleting your account">
        <P>
          Deleting your account removes every run you own and all of their stored frame data,
          along with your account record. To stop a delayed session or old auth-provider message
          from restoring it, we retain only a one-way, domain-separated hash of the auth
          identifier; it contains no handle, email, role, run, or hardware data. This is
          irreversible.
        </P>
      </Section>

      <Section title="Signing is tamper-evidence, not proof">
        <P>
          Our desktop client (once shipped) signs upload payloads, but Heimdall is open source — a
          signing key can be extracted. We record signature validity as evidence only; it is never
          used as an anti-cheat gate, and we never advertise it as one.
        </P>
      </Section>

      <Section title="Encryption">
        <P>
          All traffic runs over HTTPS. Stored data is encrypted at rest by our infrastructure
          providers&apos; platform defaults.
        </P>
      </Section>
    </main>
  );
}
