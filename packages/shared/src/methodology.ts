/**
 * Canonicalize the parser-derived portions of a declared methodology manifest.
 * The rest remains a user declaration, but resolution and frame generation must
 * agree with the run columns that power Phase 7 comparability.
 */

import type { GeneratedFrameTech, HardwareSnapshot, MethodologyManifest } from "./types";

export function normalizeMethodologyManifest(
  manifest: MethodologyManifest | undefined,
  hardware: Pick<HardwareSnapshot, "resolution">,
  generatedFrameTech: GeneratedFrameTech,
): MethodologyManifest | undefined {
  if (manifest === undefined) return undefined;

  return {
    ...manifest,
    ...(hardware.resolution === undefined ? {} : { resolution: hardware.resolution }),
    frameGeneration: generatedFrameTech,
  };
}
