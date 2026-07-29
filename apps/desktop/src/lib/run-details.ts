/**
 * Run details — the declared methodology the Complete screen collects (§16c).
 *
 * The nine `profileRequired` comparability fields decide whether a run pools
 * into game/hardware aggregates at all. Detection answers some of them —
 * resolution from the display mode, HAGS and capture tool from the client — and
 * cannot answer the rest: no amount of frame data reveals which settings preset
 * was selected or whether VRR was on.
 *
 * `graphicsApi` is the one that has to be asked. PresentMon's `PresentRuntime`
 * column names the PRESENT runtime, not the API — verified against a real
 * PresentMon 2.4.1 capture on Windows, which writes `DXGI` for D3D titles, and
 * DXGI is what every D3D10/11/12 title presents through. The parser therefore
 * maps only values that name an API on their own (`d3d12`, `vulkan`, …) and
 * degrades `DXGI` to undeclared rather than pooling DX11 and DX12 into one
 * comparability bucket. So the picker is the only source for that distinction.
 *
 * Its values canonicalize to the same identities the parser emits (`d3d12` and
 * `dx12` both collapse to `dx12`), so on the rare capture that DOES name an API
 * the engine's detection can overwrite a declaration without splitting the run
 * out of the bucket detection would have chosen.
 *
 * So the form exists, prefilled where the client genuinely knows, blank where
 * it does not, and the gaps are named with the SAME helper the web hub's
 * IncompleteProfileCard uses — one definition of "what is missing".
 */

import {
  METHODOLOGY_MANIFEST_VERSION,
  missingComparabilityProfileFields,
  type ComparabilityProfileField,
  type MethodologyManifest,
  type RayTracingMode,
  type SceneType,
  type UpscalerMode,
} from "@heimdall/shared";
import type { DeclaredHardware } from "./ipc";

export type TriBoolean = "" | "true" | "false";

export interface RunDetailsForm {
  game: string;
  visibility: "unlisted" | "public";
  resolution: string;
  scene: string;
  sceneType: SceneType | "";
  settingsPreset: string;
  graphicsApi: string;
  upscaler: UpscalerMode | "";
  rayTracing: RayTracingMode | "";
  vsync: TriBoolean;
  vrr: TriBoolean;
}

/**
 * `private` is deliberately absent: it requires a signed-in owner at create
 * time, which the claim handoff cannot provide (§20.2d). The owner flips it
 * from /account after claiming, and the UI says so rather than offering a
 * control that would fail.
 */
export const VISIBILITY_OPTIONS = [
  { value: "unlisted", label: "Unlisted" },
  { value: "public", label: "Public" },
] as const;

export const SCENE_TYPE_OPTIONS = [
  { value: "benchmark-scene", label: "Benchmark scene" },
  { value: "gameplay", label: "Gameplay" },
  { value: "freeform", label: "Freeform" },
] as const;

export const GRAPHICS_API_OPTIONS = [
  { value: "d3d12", label: "DirectX 12" },
  { value: "d3d11", label: "DirectX 11" },
  { value: "vulkan", label: "Vulkan" },
  { value: "opengl", label: "OpenGL" },
] as const;

export const UPSCALER_OPTIONS = [
  { value: "none", label: "None" },
  { value: "dlss", label: "DLSS" },
  { value: "fsr", label: "FSR" },
  { value: "xess", label: "XeSS" },
  { value: "unknown", label: "Unknown" },
] as const;

export const RAY_TRACING_OPTIONS = [
  { value: "off", label: "Off" },
  { value: "on", label: "On" },
  { value: "unknown", label: "Unknown" },
] as const;

export const BOOLEAN_OPTIONS = [
  { value: "true", label: "On" },
  { value: "false", label: "Off" },
] as const;

/** Human labels for the gaps, so the UI never shows a raw field key. */
export const PROFILE_FIELD_LABELS: Record<ComparabilityProfileField, string> = {
  resolution: "Resolution",
  scene: "Scene",
  sceneType: "Scene type",
  settingsPreset: "Settings preset",
  graphicsApi: "Graphics API",
  upscaler: "Upscaler",
  rayTracing: "Ray tracing",
  vsync: "V-Sync",
  vrr: "VRR",
};

export const EMPTY_FORM: RunDetailsForm = {
  game: "",
  visibility: "unlisted",
  resolution: "",
  scene: "",
  sceneType: "",
  settingsPreset: "",
  graphicsApi: "",
  upscaler: "",
  rayTracing: "",
  vsync: "",
  vrr: "",
};

/** Strip the `.exe` from a process name for a first guess at the game title. */
export function gameNameFromProcess(process: string | undefined): string {
  if (!process) return "";
  return process.replace(/\.exe$/i, "").trim();
}

/**
 * Seed the form from what the client actually detected. Only fields with real
 * evidence behind them are filled — everything else stays blank so the missing
 * list tells the truth.
 */
export function prefillForm(
  detected: DeclaredHardware | null,
  processName: string | undefined,
): RunDetailsForm {
  return {
    ...EMPTY_FORM,
    game: gameNameFromProcess(processName),
    resolution: detected?.hardware.resolution ?? "",
  };
}

/**
 * Form → the methodology the ingest engine sends. Blank fields are OMITTED,
 * never coerced to a default: a fabricated "none"/"off" would read as a
 * declaration and pool the run with genuinely-declared runs it does not match.
 *
 * `framePacing` is the one exception the schema forces — `vsync`/`vrr` are
 * required booleans on it — so the whole object is omitted until BOTH are
 * answered.
 */
export function toMethodology(
  form: RunDetailsForm,
): Omit<MethodologyManifest, "version" | "frameGeneration"> | undefined {
  const framePacing =
    form.vsync === "" || form.vrr === ""
      ? undefined
      : { vsync: form.vsync === "true", vrr: form.vrr === "true" };

  const manifest = {
    ...(form.resolution.trim() ? { resolution: form.resolution.trim() } : {}),
    ...(form.scene.trim() ? { scene: form.scene.trim() } : {}),
    ...(form.sceneType ? { sceneType: form.sceneType } : {}),
    ...(form.settingsPreset.trim() ? { settingsPreset: form.settingsPreset.trim() } : {}),
    ...(form.graphicsApi ? { graphicsApi: form.graphicsApi } : {}),
    ...(form.upscaler ? { upscaler: form.upscaler } : {}),
    ...(form.rayTracing ? { rayTracing: form.rayTracing } : {}),
    ...(framePacing ? { framePacing } : {}),
  };

  return Object.keys(manifest).length === 0
    ? undefined
    : (manifest as Omit<MethodologyManifest, "version" | "frameGeneration">);
}

/**
 * Which comparability fields are still undeclared, via the shared helper — the
 * same answer the run page will give after upload.
 */
export function missingFields(form: RunDetailsForm): ComparabilityProfileField[] {
  const partial = toMethodology(form);
  if (partial === undefined) return missingComparabilityProfileFields(undefined);
  return missingComparabilityProfileFields({
    version: METHODOLOGY_MANIFEST_VERSION,
    ...partial,
    // `framePacing` is required on the manifest type. When the form has not
    // answered it, hand the helper a shape whose vsync/vrr are undefined so it
    // reports them as missing rather than as a declared `false`.
    framePacing: partial.framePacing ?? ({} as MethodologyManifest["framePacing"]),
  } as MethodologyManifest);
}
