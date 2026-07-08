/**
 * Name normalization for canonical-id resolution (§4.4 / §11.9).
 *
 * `normalizeAliasName` is the lookup key in game_aliases / hardware_aliases —
 * it must be idempotent and stable across submissions of the same raw string.
 * `slugifyGameName` produces the URL slug for a newly created game row.
 */

/** Trademark/registration marks that vendors sprinkle into display strings. */
const MARK_CHARS = /[™®©]/g; // ™ ® ©

/**
 * Display-cased cleanup for newly created canonical rows: marks stripped,
 * whitespace collapsed, original casing kept. INVARIANT:
 * `cleanDisplayName(x).toLowerCase() === normalizeAliasName(x)` — §11.9
 * match-or-create relies on it (the `hardware (kind, lower(canonical_name))`
 * unique index doubles as the lookup key).
 */
export function cleanDisplayName(raw: string): string {
  return raw.replace(MARK_CHARS, "").replace(/\s+/g, " ").trim();
}

/** Canonical alias key: lowercase, marks stripped, whitespace collapsed. */
export function normalizeAliasName(raw: string): string {
  return cleanDisplayName(raw).toLowerCase();
}

/**
 * URL slug for a game: diacritics folded, unicode letters/digits kept (CJK
 * titles survive), everything else collapsed to single hyphens.
 */
export function slugifyGameName(raw: string): string {
  const folded = normalizeAliasName(raw)
    .normalize("NFKD")
    .replace(/\p{M}/gu, "");
  const slug = folded
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "untitled";
}
