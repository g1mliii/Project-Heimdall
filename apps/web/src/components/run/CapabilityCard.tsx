/**
 * Capture capability panel (§8.6.1) — what this run's source could actually
 * see: per-sensor presence and frame-alignment, capture semantics
 * (presentation/sync/frame generation/VRAM capacity), an explicit
 * bottleneck-data readiness statement for `cpuBusyMs`/`gpuBusyMs`, and any
 * source caveats. Skip-never-fail voice throughout: an absent sensor is a
 * limit of the source log, never a fault in the run. Renders nothing for
 * runs without a manifest (pre-6.5 captures) — absence is honest, no
 * placeholder card.
 */

import { Badge, Card, Diagnostic } from "@heimdall/ui";
import { CAPABILITY_SENSOR_FIELDS } from "@heimdall/shared";
import type {
  CapabilityManifest,
  CaptureCapability,
  CaptureSource,
  HagsState,
  VramCapacity,
} from "@heimdall/shared";
import { SOURCE_LABELS, formatGb } from "@/lib/format";
import { CAPTION_STYLE } from "../primitives";
import { SnapshotRow } from "./SnapshotRow";
import { busyReadinessDiagnostic, busyReadinessFromManifest } from "./busy-readiness";
import { PRESENTATION_MODE_LABELS, SENSOR_LABELS, SYNC_MODE_LABELS } from "./sensor-labels";

/**
 * Sensor coverage row, per the design kit's `SensorRow`: the badge sits
 * directly beside the key. It rides `SnapshotRow`'s chrome with the numeric
 * value slot switched off — a coverage badge is not a numeric, but the row
 * geometry is the same one, and the two kinds interleave in this card body.
 */
function SensorRow({ k, capability }: { k: string; capability: CaptureCapability }) {
  const value = !capability.present ? (
    <span aria-label="Not captured" style={{ font: "var(--type-body-sm)", color: "var(--fg-4)" }}>
      —
    </span>
  ) : capability.frameAligned ? (
    <Badge tone="good">Frame-aligned</Badge>
  ) : (
    <Badge tone="warn">Periodic — not frame-safe</Badge>
  );
  return <SnapshotRow k={k} v={value} mono={false} />;
}

function vramCapacityLabel(capacity: VramCapacity): string {
  if ("totalMb" in capacity) return formatGb(capacity.totalMb);
  return capacity.state === "unified-memory" ? "Unified memory" : "Unknown";
}

export function CapabilityCard({
  manifest,
  captureSource,
  hags,
}: {
  manifest?: CapabilityManifest;
  /**
   * Server-owned capture source from the run row. The manifest carries a
   * `source` too, but it is client-declared until the verify worker overwrites
   * it, so the badge reads the column that was never uploader-controlled.
   */
  captureSource: CaptureSource;
  /** Declared HAGS state from the methodology manifest, when present. */
  hags?: HagsState;
}) {
  if (!manifest) return null;
  const readiness = busyReadinessDiagnostic(busyReadinessFromManifest(manifest), hags);

  return (
    <Card aria-label="Capture capability">
      <Card.Header
        title="Capture capability"
        actions={<Badge tone="neutral">{SOURCE_LABELS[captureSource]}</Badge>}
      />
      <Card.Body>
        {CAPABILITY_SENSOR_FIELDS.map((field) => (
          <SensorRow key={field} k={SENSOR_LABELS[field]} capability={manifest.sensors[field]} />
        ))}
        <SnapshotRow k="Presentation" v={PRESENTATION_MODE_LABELS[manifest.presentationMode]} />
        <SnapshotRow k="Sync" v={SYNC_MODE_LABELS[manifest.syncMode]} />
        <SnapshotRow
          k="Frame generation"
          v={manifest.frameGenerationObserved ? "Observed" : "Not observed"}
        />
        <SnapshotRow k="VRAM capacity" v={vramCapacityLabel(manifest.vramCapacity)} />
        <div style={{ marginTop: "var(--space-4)" }}>
          <Diagnostic severity={readiness.severity} title={readiness.title}>
            {readiness.message}
          </Diagnostic>
        </div>
        {manifest.caveats.length > 0 && (
          <ul
            style={{
              listStyle: "none",
              display: "flex",
              flexDirection: "column",
              gap: "var(--space-1)",
              marginTop: "var(--space-3)",
            }}
          >
            {manifest.caveats.map((caveat) => (
              <li key={caveat} style={CAPTION_STYLE}>
                {caveat}
              </li>
            ))}
          </ul>
        )}
      </Card.Body>
    </Card>
  );
}
