/**
 * Human labels for capability/evidence surfaces (§8.6.1/§8.6.4/§8.6.8).
 * Closed, typed maps: adding a sensor field or capture semantic upstream fails
 * the type-check here instead of silently rendering a raw key in the UI.
 */

import type { CapabilitySensorField, PresentationMode, SyncMode } from "@heimdall/shared";

export const SENSOR_LABELS: Record<CapabilitySensorField, string> = {
  gpuLoadPct: "GPU load",
  gpuClockMhz: "GPU clock",
  gpuPowerW: "GPU power",
  vramUsedMb: "VRAM used",
  cpuLoadPct: "CPU load",
  cpuBusyMs: "CPU busy time",
  gpuBusyMs: "GPU busy time",
};

export const PRESENTATION_MODE_LABELS: Record<PresentationMode, string> = {
  "hardware-independent-flip": "Hardware independent flip",
  "hardware-composed-flip": "Hardware composed flip",
  composed: "Composed",
  legacy: "Legacy",
  unknown: "Unknown",
};

export const SYNC_MODE_LABELS: Record<SyncMode, string> = {
  vsync: "Vsync",
  tearing: "Tearing",
  vrr: "VRR",
  unknown: "Unknown",
};
