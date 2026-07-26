/**
 * Structured evidence behind one diagnostic finding (§8.6.4) — the
 * `DiagnosticEvidence` payload the server computes and the card previously
 * dropped. Collapsed by default inside a native <details> so the prose stays
 * primary; every metric renders through a closed human-label map (raw engine
 * keys never reach the DOM — unknown keys are omitted, and the drift-guard
 * test against `DIAGNOSTIC_EVIDENCE_METRIC_KEYS` fails when the contract adds
 * a key with no label here).
 */

import * as React from "react";
import { Tag } from "@heimdall/ui";
import { DIAGNOSTIC_EVIDENCE_METRIC_KEYS } from "@heimdall/shared";
import type { DiagnosticEvidence, DiagnosticEvidenceMetricKey } from "@heimdall/shared";
import { MEDIUM_DATE_FORMATTER, formatCount } from "@/lib/format";
import { CAPTION_STYLE, KeyValueRow } from "../primitives";
import { SENSOR_LABELS } from "./sensor-labels";

interface MetricLabel {
  label: string;
  kind: "fraction" | "count";
}

/** Closed label map over the attribution engine's metric keys, display order. */
export const EVIDENCE_METRIC_LABELS: Record<DiagnosticEvidenceMetricKey, MetricLabel> = {
  pairedSamples: { label: "Paired samples", kind: "count" },
  cpuBoundFraction: { label: "CPU-bound frames", kind: "fraction" },
  gpuBoundFraction: { label: "GPU-bound frames", kind: "fraction" },
  cappedFraction: { label: "Cap- or display-limited frames", kind: "fraction" },
};

function formatMetric(value: number, kind: MetricLabel["kind"]): string {
  return kind === "fraction" ? `${Math.round(value * 100)}%` : formatCount(value);
}

export function DiagnosticEvidenceDetail({ evidence }: { evidence: DiagnosticEvidence }) {
  const rows: Array<{ label: string; value: string }> = [];
  if (evidence.coverageFraction !== undefined) {
    rows.push({
      label: "Paired-frame coverage",
      value: formatMetric(evidence.coverageFraction, "fraction"),
    });
  }
  for (const key of DIAGNOSTIC_EVIDENCE_METRIC_KEYS) {
    const { label, kind } = EVIDENCE_METRIC_LABELS[key];
    const value = evidence.metrics?.[key];
    if (value !== undefined) rows.push({ label, value: formatMetric(value, kind) });
  }

  const provenance = evidence.provenance;
  const provenanceParts: React.ReactNode[] = [];
  if (provenance?.sourceUrl) {
    provenanceParts.push(
      <a
        key="source"
        href={provenance.sourceUrl}
        target="_blank"
        rel="noopener noreferrer"
        style={{ color: "var(--fg-3)", textDecoration: "underline" }}
      >
        Source
      </a>,
    );
  }
  if (provenance?.referencedVersion) {
    // Named, never a bare number: this is the version the rule compared
    // against, and on its own it reads as an orphaned figure.
    provenanceParts.push(
      <span key="version">
        Referenced version <span data-mono>{provenance.referencedVersion}</span>
      </span>,
    );
  }
  if (provenance?.fetchedAt) {
    provenanceParts.push(
      <span key="fetched">
        fetched {MEDIUM_DATE_FORMATTER.format(new Date(provenance.fetchedAt))}
      </span>,
    );
  }

  const hasContent =
    rows.length > 0 ||
    (evidence.sensors?.length ?? 0) > 0 ||
    (evidence.caveats?.length ?? 0) > 0 ||
    provenanceParts.length > 0;
  if (!hasContent) return null;

  return (
    <details style={{ marginTop: "var(--space-2)" }}>
      <summary style={{ ...CAPTION_STYLE, cursor: "pointer" }}>
        Evidence
      </summary>
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          gap: "var(--space-1)",
          marginTop: "var(--space-2)",
        }}
      >
        {rows.map((row) => (
          <KeyValueRow key={row.label} label={row.label} value={row.value} />
        ))}
        {evidence.sensors && evidence.sensors.length > 0 && (
          <div
            style={{
              display: "flex",
              gap: "var(--space-1)",
              flexWrap: "wrap",
              marginTop: "var(--space-1)",
            }}
          >
            {evidence.sensors.map((sensor) => (
              <Tag key={sensor}>{SENSOR_LABELS[sensor]}</Tag>
            ))}
          </div>
        )}
        {evidence.caveats?.map((caveat) => (
          <p key={caveat} style={CAPTION_STYLE}>
            {caveat}
          </p>
        ))}
        {provenanceParts.length > 0 && (
          <p
            style={{
              ...CAPTION_STYLE,
              display: "inline-flex",
              alignItems: "center",
              gap: "var(--space-1)",
              flexWrap: "wrap",
            }}
          >
            {provenanceParts.map((part, index) => (
              <React.Fragment key={index}>
                {index > 0 && <span aria-hidden> · </span>}
                {part}
              </React.Fragment>
            ))}
          </p>
        )}
      </div>
    </details>
  );
}
