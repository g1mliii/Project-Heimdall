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

/** Field order — shared by the TS builder and {@link comparabilityKeySql}. */
const KEY_FIELDS = [
  "gameId",
  "gpuId",
  "resolution",
  "scene",
  "settingsPreset",
  "upscaler",
  "rayTracing",
  "frameGeneration",
  "graphicsApi",
  "frameCapFps",
  "vsync",
  "vrr",
  "sceneType",
] as const;

/** A component that can't be resolved renders as this sentinel, never empty. */
const MISSING = "~";

function component(value: string | number | boolean | null): string {
  if (value === null || value === undefined) return MISSING;
  return String(value);
}

/**
 * Deterministic pooling key. Two runs share a bucket iff every comparability
 * component matches. Unresolved game/GPU render as a sentinel so they only ever
 * pool with other equally-unresolved runs (Phase 7 excludes those from public
 * aggregates via the eligibility guard, not here).
 */
export function comparabilityKey(input: ComparabilityInput): string {
  return KEY_FIELDS.map((field) => component(input[field])).join("|");
}

/**
 * The SQL expression that reproduces {@link comparabilityKey} from run columns,
 * so a Phase 7 `GROUP BY` shares one definition with the TS path. `alias` is a
 * trusted developer-supplied table alias (never user input); every value is a
 * column reference, so there is no injection surface. Column↔field order is
 * asserted against {@link KEY_FIELDS} in the tests.
 */
export function comparabilityKeySql(alias = "runs"): string {
  // Booleans render as 'true'/'false' (matching JS String(boolean)), not the
  // Postgres 't'/'f', so the SQL key is byte-identical to the TS key.
  const boolText = (column: string): string =>
    `case when ${column} is null then '${MISSING}' when ${column} then 'true' else 'false' end`;
  const parts = [
    `coalesce(${alias}.game_id::text, '${MISSING}')`,
    `coalesce(${alias}.gpu_hardware_id::text, '${MISSING}')`,
    `coalesce(${alias}.resolution, '${MISSING}')`,
    `coalesce(${alias}.scene, '${MISSING}')`,
    `coalesce(${alias}.settings_preset, '${MISSING}')`,
    `coalesce(${alias}.upscaler, '${MISSING}')`,
    `coalesce(${alias}.ray_tracing, '${MISSING}')`,
    `coalesce(${alias}.generated_frame_tech, '${MISSING}')`,
    `coalesce(${alias}.graphics_api, '${MISSING}')`,
    `coalesce(${alias}.frame_pacing_cap::text, '${MISSING}')`,
    boolText(`${alias}.vsync`),
    boolText(`${alias}.vrr`),
    `coalesce(${alias}.scene_type, '${MISSING}')`,
  ];
  // Every part is already coalesced to the '~' sentinel, so concat_ws never
  // skips a NULL and collapses distinct keys.
  return `concat_ws('|', ${parts.join(", ")})`;
}

/**
 * Index-friendly SQL predicate for two run aliases to share every component
 * of a comparability key. This deliberately uses raw `is not distinct from`
 * comparisons rather than comparing the rendered key expression, so Postgres
 * can use the partial comparability indexes. Both aliases are trusted
 * developer-supplied SQL identifiers, never user input.
 */
export function comparabilityMatchSql(leftAlias: string, rightAlias: string): string {
  return [
    "game_id",
    "gpu_hardware_id",
    "resolution",
    "scene",
    "settings_preset",
    "upscaler",
    "ray_tracing",
    "generated_frame_tech",
    "graphics_api",
    "frame_pacing_cap",
    "vsync",
    "vrr",
    "scene_type",
  ]
    .map((column) => `${leftAlias}.${column} is not distinct from ${rightAlias}.${column}`)
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
    `${alias}.resolution is not null`,
    `${alias}.scene is not null`,
    `${alias}.settings_preset is not null`,
    `${alias}.upscaler is not null`,
    `${alias}.ray_tracing is not null`,
    `${alias}.vsync is not null`,
    `${alias}.vrr is not null`,
    `${alias}.scene_type is not null`,
  ].join(" and ");
}

/** Field count, exported so the drift-guard test pins TS↔SQL column parity. */
export const COMPARABILITY_KEY_FIELD_COUNT = KEY_FIELDS.length;
