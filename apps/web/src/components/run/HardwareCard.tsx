/**
 * Hardware + software snapshot panel (§13.4). Key/value rows from the run's
 * `HardwareSnapshot` (RAM warns when actual < rated speed); once frames are
 * loaded, sensor aggregates appear below — a Meter for average GPU load and
 * peak VRAM as a plain data row (the snapshot has no VRAM-capacity field, so
 * a meter against an unknown max would lie). Absent sensors render nothing.
 */

import { Card, Meter } from "@heimdall/ui";
import type { HardwareSnapshot } from "@heimdall/shared";
import type { FrameSeries } from "@/lib/run/frame-series";
import { TriangleAlertIcon } from "./icons";

function SnapshotRow({ k, v, warn }: { k: string; v: string; warn?: boolean }) {
  return (
    <div
      style={{
        display: "flex",
        justifyContent: "space-between",
        alignItems: "center",
        paddingTop: "var(--space-2)",
        paddingBottom: "var(--space-2)",
        borderBottomWidth: "var(--border-thin)",
        borderBottomStyle: "solid",
        borderBottomColor: "var(--line-1)",
      }}
    >
      <span style={{ font: "var(--type-body-sm)", color: "var(--fg-3)" }}>{k}</span>
      <span
        data-mono
        style={{
          font: "var(--type-data)",
          color: warn ? "var(--warn)" : "var(--fg-1)",
          display: "inline-flex",
          minWidth: 0,
          alignItems: "center",
          gap: "var(--space-1)",
          overflowWrap: "anywhere",
          textAlign: "right",
        }}
      >
        {warn && <TriangleAlertIcon size={13} style={{ color: "var(--warn)" }} />}
        {v}
      </span>
    </div>
  );
}

function ramRow(hardware: HardwareSnapshot): { v: string; warn: boolean } | null {
  const { ramSpeedMtps: actual, ramRatedSpeedMtps: rated, ramGb } = hardware;
  if (actual !== undefined && rated !== undefined) {
    return { v: `${actual} / ${rated} MT/s`, warn: actual < rated };
  }
  if (actual !== undefined) return { v: `${actual} MT/s`, warn: false };
  if (ramGb !== undefined) return { v: `${ramGb} GB`, warn: false };
  return null;
}

export function HardwareCard({
  hardware,
  series,
}: {
  hardware: HardwareSnapshot;
  series?: FrameSeries;
}) {
  const ram = ramRow(hardware);
  return (
    <Card>
      <Card.Header title="Hardware snapshot" />
      <Card.Body>
        <SnapshotRow k="GPU" v={hardware.gpu} />
        <SnapshotRow k="CPU" v={hardware.cpu} />
        {hardware.gpuDriver && <SnapshotRow k="Driver" v={hardware.gpuDriver} />}
        {ram && <SnapshotRow k="RAM" v={ram.v} warn={ram.warn} />}
        {hardware.os && <SnapshotRow k="OS" v={hardware.os} />}
        {series?.peakVramUsedMb !== undefined && (
          <SnapshotRow k="Peak VRAM" v={`${(series.peakVramUsedMb / 1024).toFixed(1)} GB`} />
        )}
        {series?.avgGpuLoadPct !== undefined && (
          <div style={{ marginTop: "var(--space-4)" }}>
            <Meter
              label="Avg GPU load"
              value={series.avgGpuLoadPct}
              max={100}
              display={`${Math.round(series.avgGpuLoadPct)}%`}
            />
          </div>
        )}
      </Card.Body>
    </Card>
  );
}
