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
import { CheckIcon, ClapperboardIcon, GitCompareIcon, ShareIcon } from "./icons";

const TECH_LABELS: Record<Run["generatedFrameTech"], string | null> = {
  none: null,
  unknown: "Frame gen",
  dlss3: "DLSS 3",
  fsr3: "FSR 3",
  xess: "XeSS",
};

const SOURCE_LABELS: Record<Run["captureSource"], string> = {
  capframex: "CapFrameX log",
  presentmon: "PresentMon log",
  mangohud: "MangoHud log",
};

const VISIBILITY_LABELS: Record<Run["visibility"], string> = {
  public: "Public",
  unlisted: "Unlisted",
  private: "Private",
};

const COPY_RESET_MS = 2000;
const COMING_SOON = "Coming in a later update";

function subtitle(run: Run): string {
  const parts = [SOURCE_LABELS[run.captureSource]];
  if (run.hardware.resolution) parts.push(run.hardware.resolution);
  parts.push(`${Math.round(run.summary.durationSeconds)}s capture`);
  return parts.join(" · ");
}

export function RunHeader({ run }: { run: Run }) {
  const [copied, setCopied] = React.useState(false);
  const resetTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  React.useEffect(() => () => {
    if (resetTimer.current !== null) clearTimeout(resetTimer.current);
  }, []);

  async function share() {
    await navigator.clipboard.writeText(window.location.href);
    setCopied(true);
    if (resetTimer.current !== null) clearTimeout(resetTimer.current);
    resetTimer.current = setTimeout(() => setCopied(false), COPY_RESET_MS);
  }

  const techLabel = TECH_LABELS[run.generatedFrameTech];

  return (
    <div
      style={{
        display: "flex",
        alignItems: "flex-start",
        gap: "var(--space-4)",
        flexWrap: "wrap",
      }}
    >
      <div style={{ flex: 1, minWidth: 280 }}>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: "var(--space-2)",
            marginBottom: "var(--space-2)",
          }}
        >
          {run.status === "validated" ? (
            <Badge tone="good" dot>
              Validated
            </Badge>
          ) : (
            <Badge tone="info" dot>
              Pending verification
            </Badge>
          )}
          {techLabel && <Badge tone="brand">{techLabel}</Badge>}
          <Badge tone="neutral">{VISIBILITY_LABELS[run.visibility]}</Badge>
        </div>
        <h1 style={{ font: "var(--type-title)", color: "var(--fg-1)" }}>{run.game}</h1>
        <p style={{ font: "var(--type-body)", color: "var(--fg-2)", marginTop: "var(--space-1)" }}>
          {subtitle(run)}
        </p>
      </div>
      <div style={{ display: "flex", gap: "var(--space-2)" }}>
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
          iconLeft={copied ? <CheckIcon size={16} /> : <ShareIcon size={16} />}
        >
          {copied ? "Link copied" : "Share"}
        </Button>
      </div>
    </div>
  );
}
