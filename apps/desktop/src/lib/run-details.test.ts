/**
 * Declared-methodology coverage (§16c).
 *
 * The point of these tests is the honesty rule: a field the user has not
 * answered must be OMITTED, never defaulted. A fabricated "none"/"off" reads
 * downstream as a declaration and pools the run with genuinely-declared runs it
 * does not actually match.
 */

import { describe, expect, it } from "vitest";
import {
  EMPTY_FORM,
  gameNameFromProcess,
  missingFields,
  prefillForm,
  toMethodology,
  VISIBILITY_OPTIONS,
  type RunDetailsForm,
} from "./run-details";

const COMPLETE: RunDetailsForm = {
  ...EMPTY_FORM,
  game: "Cyberpunk 2077",
  resolution: "2560x1440",
  scene: "Built-in benchmark",
  sceneType: "benchmark-scene",
  settingsPreset: "Ultra",
  graphicsApi: "d3d12",
  upscaler: "fsr",
  rayTracing: "on",
  vsync: "false",
  vrr: "true",
};

describe("toMethodology", () => {
  it("omits every unanswered field instead of defaulting it", () => {
    expect(toMethodology(EMPTY_FORM)).toBeUndefined();

    const partial = toMethodology({ ...EMPTY_FORM, resolution: "1920x1080" });
    expect(partial).toEqual({ resolution: "1920x1080" });
    expect(partial).not.toHaveProperty("upscaler");
    expect(partial).not.toHaveProperty("rayTracing");
    expect(partial).not.toHaveProperty("framePacing");
  });

  it("withholds framePacing until BOTH vsync and vrr are answered", () => {
    // The schema makes both booleans required on framePacing, so a half-filled
    // pair would have to invent the other half.
    // Half a pair declares nothing at all, so the manifest stays absent.
    expect(toMethodology({ ...EMPTY_FORM, vsync: "true" })).toBeUndefined();
    expect(toMethodology({ ...EMPTY_FORM, scene: "Riverwood", vrr: "false" })).toEqual({
      scene: "Riverwood",
    });
    expect(toMethodology({ ...EMPTY_FORM, vsync: "true", vrr: "false" })).toEqual({
      framePacing: { vsync: true, vrr: false },
    });
  });

  it("trims text fields and treats whitespace as unanswered", () => {
    expect(toMethodology({ ...EMPTY_FORM, scene: "  Riverwood  " })).toEqual({
      scene: "Riverwood",
    });
    expect(toMethodology({ ...EMPTY_FORM, scene: "   " })).toBeUndefined();
  });

  it("passes a fully declared profile through intact", () => {
    expect(toMethodology(COMPLETE)).toEqual({
      resolution: "2560x1440",
      scene: "Built-in benchmark",
      sceneType: "benchmark-scene",
      settingsPreset: "Ultra",
      graphicsApi: "d3d12",
      upscaler: "fsr",
      rayTracing: "on",
      framePacing: { vsync: false, vrr: true },
    });
  });
});

describe("missingFields", () => {
  it("names all nine comparability fields on an empty form", () => {
    expect(missingFields(EMPTY_FORM).sort()).toEqual(
      [
        "graphicsApi",
        "rayTracing",
        "resolution",
        "scene",
        "sceneType",
        "settingsPreset",
        "upscaler",
        "vrr",
        "vsync",
      ].sort(),
    );
  });

  it("is empty once every field is declared", () => {
    expect(missingFields(COMPLETE)).toEqual([]);
  });

  it("counts an unanswered frame-pacing pair as two missing fields", () => {
    const missing = missingFields({ ...COMPLETE, vsync: "", vrr: "" });
    expect(missing.sort()).toEqual(["vrr", "vsync"]);
  });

  it("treats a declared 'off'/'none' as declared, not as missing", () => {
    // The distinction the whole module exists for: the user saying "no
    // upscaler" is information; the form being blank is not.
    expect(missingFields({ ...COMPLETE, upscaler: "none", rayTracing: "off" })).toEqual([]);
  });
});

describe("prefill", () => {
  it("seeds only fields with real detection behind them", () => {
    const form = prefillForm(
      {
        hardware: { gpu: "RX 7900 XTX", cpu: "7800X3D", resolution: "3440x1440" },
        methodology: { captureTool: "PresentMon 2.4.1" },
      },
      "Cyberpunk2077.exe",
    );
    expect(form.resolution).toBe("3440x1440");
    expect(form.game).toBe("Cyberpunk2077");
    // Nothing else is guessed — the missing list must stay truthful.
    expect(form.settingsPreset).toBe("");
    expect(form.graphicsApi).toBe("");
    expect(missingFields(form)).toContain("graphicsApi");
  });

  it("survives detection returning nothing", () => {
    expect(prefillForm(null, undefined)).toEqual(EMPTY_FORM);
  });

  it("strips the exe suffix case-insensitively", () => {
    expect(gameNameFromProcess("Game.EXE")).toBe("Game");
    expect(gameNameFromProcess(undefined)).toBe("");
  });
});

describe("visibility", () => {
  it("never offers private — the claim flow cannot create one", () => {
    // `private` needs a signed-in owner at create time (§20.2d), which the
    // browser handoff has no way to provide.
    expect(VISIBILITY_OPTIONS.map((option) => option.value)).toEqual(["unlisted", "public"]);
  });
});
