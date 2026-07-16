/**
 * Comparability key (§16c.3) — the single source of truth for "which runs may
 * be pooled together." Phase 7 aggregate pages must group by this key so runs
 * captured under different methodology or frame-pacing semantics never share a
 * bucket. Modeled on `visibility.ts`'s `aggregateEligibilitySql`: the TypeScript
 * function and the SQL expression compute the SAME key, so no query re-derives
 * it and the two can't drift.
 *
 * The key intentionally spans: canonical game + canonical GPU (the hardware/
 * title identity), resolution + upscaler + ray-tracing + frame-generation (the
 * rendering pipeline), graphics API, the frame-pacing ceiling (cap/VSync/VRR),
 * the declared route and graphics preset, and the scene type (a
 * `benchmark-scene` never pools with `gameplay`, and `freeform` stays
 * separately filterable per §17.5).
 */

import type {
  GeneratedFrameTech,
  MethodologyManifest,
  RayTracingMode,
  SceneType,
  UpscalerMode,
} from "./types";

/** Everything the comparability key is derived from (canonical, server-resolved). */
export interface ComparabilityInput {
  /** Canonical game id (null when unresolved — such runs can't be pooled). */
  gameId: string | null;
  /** Canonical GPU hardware id (null when unresolved). */
  gpuId: string | null;
  resolution: string | null;
  scene: string | null;
  settingsPreset: string | null;
  upscaler: UpscalerMode;
  rayTracing: RayTracingMode;
  frameGeneration: GeneratedFrameTech;
  /** Runtime graphics API (null when the capture did not expose one). */
  graphicsApi: string | null;
  /** Applied FPS cap, or null for uncapped. */
  frameCapFps: number | null;
  vsync: boolean;
  vrr: boolean;
  sceneType: SceneType;
}

/** A component that can't be resolved renders as this sentinel, never empty. */
const MISSING = "~";

function component(value: string | number | boolean | null): string {
  if (value === null || value === undefined) return MISSING;
  return String(value);
}

type ComparabilityKeyField = {
  inputKey: keyof ComparabilityInput;
  column: string;
  profileRequired?: true;
  sqlComponent: (column: string) => string;
};

function nullableTextSql(column: string): string {
  return `coalesce(${column}, '${MISSING}')`;
}

function nullableNumberSql(column: string): string {
  return `coalesce(${column}::text, '${MISSING}')`;
}

function nullableBooleanSql(column: string): string {
  // Booleans render as 'true'/'false' (matching JS String(boolean)), not the
  // Postgres 't'/'f', so the SQL key is byte-identical to the TS key.
  return `case when ${column} is null then '${MISSING}' when ${column} then 'true' else 'false' end`;
}

/**
 * Single descriptor list for the TypeScript key, SQL key, SQL match predicate,
 * and declared-profile gate. A new comparability dimension cannot land in only
 * one path and silently split Phase 7 distributions from repeatability sets.
 */
const KEY_FIELDS = [
  { inputKey: "gameId", column: "game_id", sqlComponent: nullableNumberSql },
  { inputKey: "gpuId", column: "gpu_hardware_id", sqlComponent: nullableNumberSql },
  { inputKey: "resolution", column: "resolution", profileRequired: true, sqlComponent: nullableTextSql },
  { inputKey: "scene", column: "scene", profileRequired: true, sqlComponent: nullableTextSql },
  {
    inputKey: "settingsPreset",
    column: "settings_preset",
    profileRequired: true,
    sqlComponent: nullableTextSql,
  },
  { inputKey: "upscaler", column: "upscaler", profileRequired: true, sqlComponent: nullableTextSql },
  { inputKey: "rayTracing", column: "ray_tracing", profileRequired: true, sqlComponent: nullableTextSql },
  { inputKey: "frameGeneration", column: "generated_frame_tech", sqlComponent: nullableTextSql },
  { inputKey: "graphicsApi", column: "graphics_api", profileRequired: true, sqlComponent: nullableTextSql },
  { inputKey: "frameCapFps", column: "frame_pacing_cap", sqlComponent: nullableNumberSql },
  { inputKey: "vsync", column: "vsync", profileRequired: true, sqlComponent: nullableBooleanSql },
  { inputKey: "vrr", column: "vrr", profileRequired: true, sqlComponent: nullableBooleanSql },
  { inputKey: "sceneType", column: "scene_type", profileRequired: true, sqlComponent: nullableTextSql },
] as const satisfies readonly ComparabilityKeyField[];

/**
 * Deterministic pooling key. Two runs share a bucket iff every comparability
 * component matches. Unresolved game/GPU render as a sentinel so they only ever
 * pool with other equally-unresolved runs (Phase 7 excludes those from public
 * aggregates via the eligibility guard, not here).
 */
export function comparabilityKey(input: ComparabilityInput): string {
  return KEY_FIELDS.map((field) => component(input[field.inputKey])).join("|");
}

/**
 * The SQL expression that reproduces {@link comparabilityKey} from run columns,
 * so a Phase 7 `GROUP BY` shares one definition with the TS path. `alias` is a
 * trusted developer-supplied table alias (never user input); every value is a
 * column reference, so there is no injection surface. Column↔field order is
 * asserted against {@link KEY_FIELDS} in the tests.
 */
export function comparabilityKeySql(alias = "runs"): string {
  const parts = KEY_FIELDS.map((field) => field.sqlComponent(`${alias}.${field.column}`));
  // Every part is already coalesced to the '~' sentinel, so concat_ws never
  // skips a NULL and collapses distinct keys.
  return `concat_ws('|', ${parts.join(", ")})`;
}

/**
 * The exact column projection needed before comparing a base run to candidate
 * runs. `alias` is a trusted developer-supplied SQL identifier.
 */
export function comparabilitySelectSql(alias = "runs"): string {
  return KEY_FIELDS.map(({ column }) => `${alias}.${column}`).join(", ");
}

/**
 * Index-friendly SQL predicate for two run aliases to share every component
 * of a comparability key. This deliberately uses raw `is not distinct from`
 * comparisons rather than comparing the rendered key expression, so Postgres
 * can use the partial comparability indexes. Both aliases are trusted
 * developer-supplied SQL identifiers, never user input.
 */
export function comparabilityMatchSql(leftAlias: string, rightAlias: string): string {
  return KEY_FIELDS.map(
    ({ column }) => `${leftAlias}.${column} is not distinct from ${rightAlias}.${column}`,
  )
    .join(" and ");
}

/**
 * SQL predicate for a declared, complete-enough methodology profile.
 *
 * A sentinel comparability key is useful for deterministic diagnostics, but it
 * is deliberately NOT permission to pool undeclared runs.  A run without this
 * profile stays individually visible and retains its raw data; it simply has
 * no public aggregate/repeatability bucket (§16c.1/§16c.3).
 *
 * `alias` is a trusted developer-supplied table alias, just like
 * {@link comparabilityKeySql}.
 */
export function comparabilityProfileSql(alias = "runs"): string {
  return [
    `${alias}.methodology_manifest_version is not null`,
    ...KEY_FIELDS.filter((field) => "profileRequired" in field).map(
      ({ column }) => `${alias}.${column} is not null`,
    ),
  ].join(" and ");
}

/** Field count, exported so the drift-guard test pins TS↔SQL column parity. */
export const COMPARABILITY_KEY_FIELD_COUNT = KEY_FIELDS.length;

/** The declared-profile fields {@link comparabilityProfileSql} gates on. */
export type ComparabilityProfileField = Extract<
  (typeof KEY_FIELDS)[number],
  { profileRequired: true }
>["inputKey"];

const PROFILE_FIELDS = KEY_FIELDS.filter(
  (field): field is Extract<(typeof KEY_FIELDS)[number], { profileRequired: true }> =>
    "profileRequired" in field,
).map((field) => field.inputKey);

/**
 * The manifest value behind each declared-profile run column. Keyed by
 * `ComparabilityProfileField`, so adding `profileRequired` to a new key fails to
 * compile until that key can also be explained to the user — a gate nobody can
 * see is why an incomplete profile used to render nothing at all.
 */
const PROFILE_FIELD_VALUE: Record<
  ComparabilityProfileField,
  (manifest: MethodologyManifest) => string | boolean | undefined
> = {
  resolution: (manifest) => manifest.resolution,
  scene: (manifest) => manifest.scene,
  settingsPreset: (manifest) => manifest.settingsPreset,
  upscaler: (manifest) => manifest.upscaler,
  rayTracing: (manifest) => manifest.rayTracing,
  graphicsApi: (manifest) => manifest.graphicsApi,
  vsync: (manifest) => manifest.framePacing.vsync,
  vrr: (manifest) => manifest.framePacing.vrr,
  sceneType: (manifest) => manifest.sceneType,
};

/**
 * Which declared-profile fields this manifest leaves undeclared — the exact
 * reason {@link comparabilityProfileSql} would reject the run. Empty means the
 * profile is complete, so a missing benchmark set has some other cause (too few
 * repeats, unresolved game/GPU, or a non-public run).
 */
export function missingComparabilityProfileFields(
  manifest: MethodologyManifest | undefined,
): ComparabilityProfileField[] {
  if (manifest === undefined) return [...PROFILE_FIELDS];
  return PROFILE_FIELDS.filter((field) => {
    const value = PROFILE_FIELD_VALUE[field](manifest);
    return value === undefined || value === "";
  });
}
