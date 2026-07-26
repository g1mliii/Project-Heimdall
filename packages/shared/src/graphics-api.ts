/**
 * Canonical graphics-API identity (§16c.1/§16c.3).
 *
 * The manifest accepts free text because capture tools can expose APIs Heimdall
 * does not know yet. Only well-known spelling aliases collapse; unknown values
 * stay intact so distinct rendering pipelines never pool accidentally.
 */

/**
 * Exported because migration `0039_canonical_graphics_api.sql` hand-copies this
 * table into SQL to backfill existing rows — a migration is frozen once merged,
 * so a drift test pins the two lists together. Adding an alias here needs a new
 * backfill migration, or stored rows and freshly-written ones pool apart.
 */
export const GRAPHICS_API_ALIASES = {
  dx12: "dx12",
  d3d12: "dx12",
  directx12: "dx12",
  dx11: "dx11",
  d3d11: "dx11",
  directx11: "dx11",
  vulkan: "vulkan",
  opengl: "opengl",
  metal: "metal",
} as const satisfies Readonly<Record<string, string>>;

/**
 * The values `canonicalGraphicsApi` can collapse an alias to. Free text that
 * matches no alias passes through untouched, so this is not a closed union of
 * every stored value — only of the known ones.
 */
export type CanonicalGraphicsApi = (typeof GRAPHICS_API_ALIASES)[keyof typeof GRAPHICS_API_ALIASES];

/** Normalize a known alias while preserving trimmed, unknown free text. */
export function canonicalGraphicsApi(api: string): string {
  const trimmed = api.trim();
  const lookup = trimmed.toLowerCase().replace(/[\s_-]/g, "");
  return (GRAPHICS_API_ALIASES as Readonly<Record<string, string>>)[lookup] ?? trimmed;
}
