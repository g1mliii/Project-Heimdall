/**
 * Best-effort hardware-detail extraction shared by the source parsers. Total
 * dedicated VRAM feeds the Phase 6 VRAM-saturation rule (§15.1); it is
 * enrichment, never a gate — an unparseable value simply yields `undefined`
 * and the rule no-ops.
 */

/** Bare numbers at/below this are read as GB — real dedicated VRAM never exceeds ~128 GB. */
const GB_HEURISTIC_MAX = 128;
/** Plausible dedicated-VRAM ceiling in MB (256 GB) — anything larger is a unit mistake. */
const MB_PLAUSIBLE_MAX = 256 * 1024;
/** Plausible floor in MB (256 MB) — smaller "capacity" is almost certainly a used/mis-parsed value. */
const MB_PLAUSIBLE_MIN = 256;

/**
 * Parse a dedicated-VRAM capacity into whole megabytes. Accepts a numeric value
 * or a string like `"12288 MB"` / `"12 GB"` / `"16384"`; returns `undefined` for
 * anything non-positive, unrecognizable, or implausible.
 *
 * Unit-tagged strings are trusted. A bare number is disambiguated by magnitude —
 * a source may report GB, MB, KB, or raw bytes — then the result is clamped to a
 * plausible VRAM range so a byte count (e.g. 12884901888) can't slip through as
 * 12.8 billion MB and quietly disable the §15.1 rule.
 */
export function parseVramTotalMb(value: unknown): number | undefined {
  let amount: number | undefined;
  let unit: "mb" | "gb" | undefined;

  if (typeof value === "number") {
    amount = value;
  } else if (typeof value === "string") {
    // Accept only a capacity value, not an arbitrary hardware-description
    // string. Taking the first number from "RTX 4090 24 GB" as 4090 MB would
    // manufacture a false saturation finding.
    const match = /^\s*(\d{1,3}(?:,\d{3})+|\d+(?:\.\d+)?)\s*(gib|gb|mib|mb)?\s*$/i.exec(value);
    if (match) {
      amount = Number.parseFloat(match[1]!.replaceAll(",", ""));
      const tag = match[2]?.toLowerCase();
      if (tag === "gb" || tag === "gib") unit = "gb";
      else if (tag === "mb" || tag === "mib") unit = "mb";
    }
  }

  if (amount === undefined || !Number.isFinite(amount) || amount <= 0) return undefined;

  let mb: number;
  if (unit === "gb") mb = amount * 1024;
  else if (unit === "mb") mb = amount;
  else if (amount <= GB_HEURISTIC_MAX) mb = amount * 1024; // bare, GB scale
  else if (amount <= MB_PLAUSIBLE_MAX) mb = amount; // bare, MB scale
  else if (amount <= MB_PLAUSIBLE_MAX * 1024) mb = amount / 1024; // bare, KB scale
  else mb = amount / (1024 * 1024); // bare, byte scale

  mb = Math.round(mb);
  if (mb < MB_PLAUSIBLE_MIN || mb > MB_PLAUSIBLE_MAX) return undefined;
  return mb;
}
