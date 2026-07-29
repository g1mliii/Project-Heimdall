"use client";

/**
 * Run-report title block (§13.6) — status/tech/visibility badges, game title,
 * capture facts, and the action row. Share is live (copies the current URL);
 * Compare and Export video are visible-but-disabled entry points to Phases
 * 10/11 so the header matches the design reference without dead buttons.
 */

import * as React from "react";
import { Badge, Button } from "@heimdall/ui";
import type { Run } from "@heimdall/shared";
import { ReportButton } from "@/components/moderation/ReportButton";
import {
  SOURCE_LABELS,
  UPSCALER_LABELS,
  VISIBILITY_LABELS,
  graphicsApiLabel,
} from "@/lib/format";
import { CheckIcon, ClapperboardIcon, GitCompareIcon, ShareIcon } from "./icons";

const TECH_LABELS: Record<Run["generatedFrameTech"], string | null> = {
  none: null,
  unknown: "Frame gen",
  dlss3: "DLSS 3",
  fsr3: "FSR 3",
  xess: "XeSS",
};

const COPY_RESET_MS = 2000;
const COMING_SOON = "Coming in a later update";

/**
 * Status badge (§20.5). `moderated` and `flagged` runs 404 for everyone but
 * their owner (`isVisibleTo` in lib/repo/runs.ts), so if one of those renders
 * at all the reader IS the owner — and they are the one person who needs to
 * be told the run is no longer public, and why. Silence here meant a takedown
 * looked identical to a normal report while the run had quietly dropped out
 * of every public surface. `hidden` is the deletion tombstone: never visible
 * to anyone, so it has no badge.
 */
function StatusBadge({ status }: { status: Run["status"] }) {
  switch (status) {
    case "validated":
      return (
        <Badge tone="good" dot>
          Validated
        </Badge>
      );
    case "moderated":
      return (
        <Badge tone="bad" dot>
          Removed by moderation
        </Badge>
      );
    case "flagged":
      return (
        <Badge tone="warn" dot>
          Failed integrity check
        </Badge>
      );
    default:
      return (
        <Badge tone="info" dot>
          Pending verification
        </Badge>
      );
  }
}

/**
 * Client-signature evidence (§0.5, §11.7, §22.3).
 *
 * Rendered ONLY when the server actually verified a signature — that is, when
 * the run carried one and a public key was configured. Browser uploads carry no
 * signature at all, and stamping "unsigned" on every one of those would read as
 * a defect rather than as the norm it is.
 *
 * The copy is deliberately flat. A signature says the payload came from
 * something that looks like an unmodified desktop client, and the key ships
 * inside a downloadable binary, so it is extractable. It is evidence and never
 * an acceptance gate — the run's own integrity verdict is the `Validated` badge
 * beside this one, and it is derived from the server's recompute, not from
 * this.
 */
function SignatureBadge({ signatureValid }: { signatureValid: Run["signatureValid"] }) {
  if (signatureValid === undefined || signatureValid === null) return null;
  return signatureValid ? (
    <Badge tone="neutral" title="Signed by a desktop capture client. Tamper-evidence only — it is not proof the capture is genuine, and it never affects whether a run is accepted.">
      Client signature checks out
    </Badge>
  ) : (
    <Badge tone="warn" title="The payload did not match its signature. Recorded as evidence only — this run was still verified on its own merits by the server recompute.">
      Client signature mismatch
    </Badge>
  );
}

const OWNER_ONLY_STATUS_NOTE: Partial<Record<Run["status"], string>> = {
  moderated:
    "A moderator removed this run from public view. Only you can see it — it is excluded from game pages and public averages.",
  flagged:
    "This run failed a server-side integrity check. Only you can see it — it is excluded from public averages.",
};

/**
 * §8.6.2 — the declared settings string per the design kit ("Ultra · Ray
 * tracing · 2560x1440 · DX12 · 62s capture"). Declared fields that are absent
 * are skipped, never dashed out. Runs without a methodology manifest keep the
 * pre-8.6 capture-facts string.
 *
 * The capture source leads both branches. It used to be dropped from the
 * manifest branch on the assumption that CapabilityCard's source badge covered
 * it, but that card gates on `capabilityManifest` while this gates on
 * `methodologyManifest` — independently optional fields, and the capability
 * manifest only lands canonically once the verify worker runs. A run that
 * declared methodology before verification would have named its source nowhere.
 */
function subtitle(run: Run): string {
  const manifest = run.methodologyManifest;
  const parts = [SOURCE_LABELS[run.captureSource]];
  if (!manifest) {
    if (run.hardware.resolution) parts.push(run.hardware.resolution);
    parts.push(`${Math.round(run.summary.durationSeconds)}s capture`);
    return parts.join(" · ");
  }
  if (manifest.settingsPreset) parts.push(manifest.settingsPreset);
  // The domain model records ray tracing as off/on/unknown — no named RT tier,
  // so the kit's "Ray Tracing: Overdrive" collapses to the honest "Ray tracing".
  if (manifest.rayTracing === "on") parts.push("Ray tracing");
  const resolution = manifest.resolution ?? run.hardware.resolution;
  if (resolution) parts.push(resolution);
  if (manifest.graphicsApi) parts.push(graphicsApiLabel(manifest.graphicsApi));
  const upscaler = UPSCALER_LABELS[manifest.upscaler];
  if (upscaler) parts.push(upscaler);
  // Capture length comes from the server recompute, never the declared
  // `captureDurationSeconds`: the methodology manifest is uploader-declared and
  // never recomputed, so preferring it let a client contradict the canonical
  // summary the stat tiles below are rendered from (§11.5).
  parts.push(`${Math.round(run.summary.durationSeconds)}s capture`);
  return parts.join(" · ");
}

type ShareState = "idle" | "copied" | "failed";

export function RunHeader({ run }: { run: Run }) {
  const [shareState, setShareState] = React.useState<ShareState>("idle");
  const resetTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  React.useEffect(() => () => {
    if (resetTimer.current !== null) clearTimeout(resetTimer.current);
  }, []);

  async function share() {
    if (resetTimer.current !== null) clearTimeout(resetTimer.current);
    try {
      // Throws (or is undefined) on insecure contexts, denied permission, or an
      // unfocused document — surface "Copy failed" instead of a silent no-op.
      await navigator.clipboard.writeText(window.location.href);
      setShareState("copied");
    } catch {
      setShareState("failed");
    }
    resetTimer.current = setTimeout(() => setShareState("idle"), COPY_RESET_MS);
  }

  const techLabel = TECH_LABELS[run.generatedFrameTech];
  const statusNote = OWNER_ONLY_STATUS_NOTE[run.status];

  return (
    <div
      style={{
        display: "flex",
        alignItems: "flex-start",
        gap: "var(--space-4)",
        flexWrap: "wrap",
      }}
    >
      <div style={{ flex: 1, minWidth: 0 }}>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: "var(--space-2)",
            marginBottom: "var(--space-2)",
          }}
        >
          <StatusBadge status={run.status} />
          {techLabel && <Badge tone="brand">{techLabel}</Badge>}
          <Badge tone="neutral">{VISIBILITY_LABELS[run.visibility]}</Badge>
          <SignatureBadge signatureValid={run.signatureValid} />
        </div>
        {statusNote && (
          <p
            style={{
              font: "var(--type-body-sm)",
              color: "var(--fg-2)",
              marginBottom: "var(--space-2)",
            }}
          >
            {statusNote}
          </p>
        )}
        <h1 style={{ font: "var(--type-title)", color: "var(--fg-1)", overflowWrap: "anywhere" }}>
          {run.game}
        </h1>
        <p
          style={{
            font: "var(--type-body)",
            color: "var(--fg-2)",
            marginTop: "var(--space-1)",
            overflowWrap: "anywhere",
          }}
        >
          {subtitle(run)}
        </p>
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", justifyContent: "flex-end", gap: "var(--space-2)", alignItems: "center" }}>
        <ReportButton subject={{ type: "run", id: run.id }} />
        <Button
          variant="secondary"
          disabled
          title={COMING_SOON}
          iconLeft={<GitCompareIcon size={16} />}
        >
          Compare
        </Button>
        <Button
          variant="secondary"
          disabled
          title={COMING_SOON}
          iconLeft={<ClapperboardIcon size={16} />}
        >
          Export video
        </Button>
        <Button
          variant="primary"
          onClick={() => void share()}
          aria-live="polite"
          aria-atomic="true"
          iconLeft={shareState === "copied" ? <CheckIcon size={16} /> : <ShareIcon size={16} />}
        >
          {shareState === "copied"
            ? "Link copied"
            : shareState === "failed"
              ? "Copy failed"
              : "Share"}
        </Button>
      </div>
    </div>
  );
}
