// The user-facing vocabulary for the declared-methodology enums (§16c).
//
// Every front door that asks for this metadata — the web upload form and the
// desktop capture client — asks for the SAME nine comparability fields with the
// same allowed values, so the labels belong beside the enums rather than inline
// in each form. They were duplicated once and had already drifted: the run page
// reported a gap as "Scene or route" that the desktop form called "Scene", and
// the same upscaler value read "Off" on one surface and "None" on the other.
//
// Option ORDER is shared; the selected value is not. Each form still decides
// what an unanswered field means (the web hub ships an explicit `unknown`, the
// desktop omits the key) — that is a declaration-semantics decision, not a
// vocabulary one.

import type { ComparabilityProfileField } from "./comparability";
import type { GeneratedFrameTech, RayTracingMode, SceneType, UpscalerMode } from "./types";

export interface MethodologyOption<T extends string> {
  readonly value: T;
  readonly label: string;
}

/**
 * Human labels for the comparability profile fields, so no surface ever shows a
 * raw field key and every surface names the same gap the same way.
 *
 * Exhaustive over `ComparabilityProfileField`: adding `profileRequired` to a new
 * comparability key fails to typecheck here until it is given a label.
 */
export const COMPARABILITY_FIELD_LABELS: Record<ComparabilityProfileField, string> = {
  resolution: "Resolution",
  scene: "Scene or route",
  sceneType: "Scene type",
  settingsPreset: "Settings preset",
  graphicsApi: "Graphics API",
  upscaler: "Upscaler",
  rayTracing: "Ray tracing",
  vsync: "VSync",
  vrr: "VRR",
};

export const SCENE_TYPE_OPTIONS: readonly MethodologyOption<SceneType>[] = [
  { value: "benchmark-scene", label: "Benchmark scene" },
  { value: "gameplay", label: "Gameplay" },
  { value: "freeform", label: "Freeform" },
];

/**
 * Graphics API. Asked rather than detected: PresentMon's `PresentRuntime` names
 * the present runtime, and every D3D10/11/12 title presents through DXGI, so the
 * capture cannot tell DX11 from DX12. Values canonicalize to the identities the
 * parser emits, so a capture that DOES name an API agrees with a declaration.
 */
export const GRAPHICS_API_OPTIONS: readonly MethodologyOption<string>[] = [
  { value: "d3d12", label: "DirectX 12" },
  { value: "d3d11", label: "DirectX 11" },
  { value: "vulkan", label: "Vulkan" },
  { value: "opengl", label: "OpenGL" },
];

export const UPSCALER_OPTIONS: readonly MethodologyOption<UpscalerMode>[] = [
  { value: "none", label: "Off" },
  { value: "dlss", label: "DLSS" },
  { value: "fsr", label: "FSR" },
  { value: "xess", label: "XeSS" },
  { value: "unknown", label: "Unknown" },
];

export const RAY_TRACING_OPTIONS: readonly MethodologyOption<RayTracingMode>[] = [
  { value: "off", label: "Off" },
  { value: "on", label: "On" },
  { value: "unknown", label: "Unknown" },
];

/**
 * Frame generation (§22.11). Declared, never inferred: AMD's driver emits no
 * frame-type evidence, so a run with frame generation on presents roughly twice
 * as many frames and every one looks like a real present.
 */
export const FRAME_GENERATION_OPTIONS: readonly MethodologyOption<GeneratedFrameTech>[] = [
  { value: "none", label: "Off" },
  { value: "fsr3", label: "FSR frame generation" },
  { value: "dlss3", label: "DLSS frame generation" },
  { value: "xess", label: "XeSS frame generation" },
  { value: "unknown", label: "On, not sure which" },
];
