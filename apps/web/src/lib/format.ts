/**
 * Display formatters and label maps shared across screens, so the same value
 * never renders two different ways on two pages.
 *
 * Dates AND numbers are pinned to a fixed locale (and dates to a fixed
 * timezone) on purpose: Client Components render on the server before
 * hydration, and `toLocaleDateString()`/`toLocaleString()` with no args read
 * the runtime's locale — which differs between the server and a browser. Dev
 * mode surfaces that mismatch as a hydration error.
 */

import type {
  CaptureSource,
  HagsState,
  ReportRow,
  RunVisibility,
  UpscalerMode,
} from "@heimdall/shared";
import { canonicalGraphicsApi } from "@heimdall/shared";

export const MEDIUM_DATE_FORMATTER = new Intl.DateTimeFormat("en", {
  dateStyle: "medium",
  timeZone: "UTC",
});

/**
 * Grouped integers ("12,480"). Pinned to "en" for the same reason the date
 * formatter is: a bare `toLocaleString()` renders "12.480" in a de-DE browser
 * against the server's "12,480" and mismatches on hydration.
 */
const COUNT_FORMATTER = new Intl.NumberFormat("en");

export function formatCount(value: number): string {
  return COUNT_FORMATTER.format(value);
}

function gbValue(megabytes: number): string {
  return (megabytes / 1024).toFixed(1);
}

/**
 * MB → GB, one rounding rule everywhere. Capacity and usage are read against
 * each other on the run page ("11.4 / 12.0 GB"), so a capacity that rendered
 * as a bare "12 GB" beside a one-decimal usage read as two different numbers.
 */
export function formatGb(megabytes: number): string {
  return `${gbValue(megabytes)} GB`;
}

/** Usage against capacity ("11.4 / 12.0 GB") — both halves on the same rule. */
export function formatGbRange(usedMb: number, totalMb: number): string {
  return `${gbValue(usedMb)} / ${formatGb(totalMb)}`;
}

export const VISIBILITY_LABELS: Record<RunVisibility, string> = {
  public: "Public",
  unlisted: "Unlisted",
  private: "Private",
};

export const SOURCE_LABELS: Record<CaptureSource, string> = {
  capframex: "CapFrameX log",
  presentmon: "PresentMon log",
  mangohud: "MangoHud log",
};

export const REPORT_REASON_LABELS: Record<ReportRow["reason"], string> = {
  "abusive-name": "Abusive name",
  "bad-faith-upload": "Bad-faith upload",
  other: "Other",
};

/**
 * HAGS state, one casing for every screen — the upload form's select options
 * and the submissions table's declared-profile tooltip read the same map.
 */
export const HAGS_LABELS: Record<HagsState, string> = {
  enabled: "Enabled",
  disabled: "Disabled",
  unknown: "Unknown",
};

/**
 * Upscaler brand casing, closed over the domain union. `null` marks the values
 * that carry no methodology signal, so every surface hides the same set —
 * `.toUpperCase()` used to render "XESS" one line from a badge saying "XeSS".
 */
export const UPSCALER_LABELS: Record<UpscalerMode, string | null> = {
  none: null,
  unknown: null,
  dlss: "DLSS",
  fsr: "FSR",
  xess: "XeSS",
};

/**
 * `graphicsApi` is declared free text (§16c.1), so this is a canonical-casing
 * lookup rather than a closed map: known APIs get their brand casing, anything
 * else falls back to upper case rather than being dropped.
 */
const GRAPHICS_API_LABELS: Record<string, string> = {
  dx12: "DX12",
  dx11: "DX11",
  vulkan: "Vulkan",
  opengl: "OpenGL",
  metal: "Metal",
};

/**
 * Frame-pacing tokens ("120 FPS cap", "VSync"/"no VSync", "VRR"/"no VRR"),
 * written once. The cohort selector and the submissions table sit on the same
 * screen describing the same pacing config, so a reworded token has to move
 * both at once.
 *
 * A `null` dimension was not declared and is omitted entirely, so absence never
 * reads as a declared "off". A cohort key, whose members all share one setting,
 * states its always-known cap itself and passes the rest through here.
 */
export function framePacingParts(pacing: {
  capFps: number | null;
  vsync: boolean | null;
  vrr: boolean | null;
}): string[] {
  const { capFps, vsync, vrr } = pacing;
  const parts: string[] = [];
  if (capFps !== null) parts.push(`${capFps} FPS cap`);
  if (vsync !== null) parts.push(vsync ? "VSync" : "no VSync");
  if (vrr !== null) parts.push(vrr ? "VRR" : "no VRR");
  return parts;
}

/** "12,480 runs" / "1 run" — count and noun, agreeing, in one place. */
export function pluralCount(value: number, singular: string, plural: string): string {
  return `${formatCount(value)} ${value === 1 ? singular : plural}`;
}

export function graphicsApiLabel(api: string): string {
  const canonical = canonicalGraphicsApi(api);
  return GRAPHICS_API_LABELS[canonical] ?? canonical.toUpperCase();
}
