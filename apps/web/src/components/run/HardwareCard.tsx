/**
 * Hardware + software snapshot panel (§13.4, §8.6.5). Key/value rows from the
 * run's `HardwareSnapshot` (RAM warns when actual < rated speed); once frames
 * are loaded, sensor aggregates appear below — a Meter for average GPU load,
 * and peak VRAM as a meter against the known capacity when there is one, or a
 * plain data row when there isn't (a meter against an unknown max would lie).
 * Absent sensors render nothing.
 */

import { Card, Meter } from "@heimdall/ui";
import type { CapabilityManifest, HardwareSnapshot } from "@heimdall/shared";
import { formatGb, formatGbRange } from "@/lib/format";
import type { FrameSeries } from "@/lib/run/frame-series";
import { SnapshotRow } from "./SnapshotRow";

/** VRAM meters go bad-red at this fill fraction, per the design kit. */
const VRAM_PRESSURE_FRACTION = 0.95;

/**
 * The capacity the meter is drawn against. `gpuVramTotalMb` is the parsed
 * hardware fact and therefore wins over the client-declared capability
 * manifest (§11.5/§16a.4). The manifest is a fallback for captures whose
 * hardware snapshot has no total; canonical verification preserves that
 * explicit state, so those runs still get an honest meter.
 */
function vramCapacityMb(
  hardware: HardwareSnapshot,
  manifest?: CapabilityManifest,
): number | undefined {
  if (hardware.gpuVramTotalMb !== undefined) return hardware.gpuVramTotalMb;
  const declared = manifest?.vramCapacity;
  return declared && "totalMb" in declared ? declared.totalMb : undefined;
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
  capabilityManifest,
  series,
}: {
  hardware: HardwareSnapshot;
  capabilityManifest?: CapabilityManifest;
  series?: FrameSeries;
}) {
  const ram = ramRow(hardware);
  const peakVramMb = series?.peakVramUsedMb;
  const vramTotalMb = vramCapacityMb(hardware, capabilityManifest);
  return (
    <Card>
      <Card.Header title="Hardware snapshot" />
      <Card.Body>
        {/* No separate vendor row: the GPU string already leads with the
            vendor, and the design kit's hardware card has no such row. */}
        <SnapshotRow k="GPU" v={hardware.gpu} />
        <SnapshotRow k="CPU" v={hardware.cpu} />
        {hardware.gpuDriver && <SnapshotRow k="Driver" v={hardware.gpuDriver} />}
        {ram && <SnapshotRow k="RAM" v={ram.v} warn={ram.warn} />}
        {hardware.os && <SnapshotRow k="OS" v={hardware.os} />}
        {peakVramMb !== undefined && vramTotalMb === undefined && (
          <SnapshotRow k="Peak VRAM" v={formatGb(peakVramMb)} />
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
        {peakVramMb !== undefined && vramTotalMb !== undefined && (
          <div style={{ marginTop: "var(--space-4)" }}>
            <Meter
              label="Peak VRAM"
              value={peakVramMb}
              max={vramTotalMb}
              display={formatGbRange(peakVramMb, vramTotalMb)}
              color={
                peakVramMb / vramTotalMb >= VRAM_PRESSURE_FRACTION ? "var(--bad)" : undefined
              }
            />
          </div>
        )}
      </Card.Body>
    </Card>
  );
}
