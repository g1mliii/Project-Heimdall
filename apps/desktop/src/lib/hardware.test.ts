/**
 * Which hardware source wins, per field (§23.2).
 *
 * The stakes: `uploadCaptureBytes` layers `options.hardware` OVER the parser's
 * snapshot, so without this rule the Linux client's `/sys` reads would replace
 * MangoHud's `Mesa 26.1.4` with a kernel module name — and the Linux
 * driver-currency rules match Mesa release strings, so every Linux run would
 * silently miss.
 */

import { describe, expect, it } from "vitest";
import type { HardwareSnapshot } from "@heimdall/shared";

import { deferToCapture } from "./hardware";

/** What linux.rs reports: gaps filled, GPU deliberately unnamed. */
const DECLARED: HardwareSnapshot = {
  gpu: "Unknown GPU",
  cpu: "AMD Ryzen 7 9800X3D 8-Core Processor",
  gpuVendor: "amd",
  ramGb: 31.2,
  os: "SteamOS 3.7.13 (kernel 6.11.11-valve)",
  gpuDriver: "amdgpu (kernel 6.11.11-valve)",
  gpuVramTotalMb: 16368,
  resolution: "2560x1440",
};

/** What MangoHud's sysinfo row carries. */
const FROM_CAPTURE: Partial<HardwareSnapshot> = {
  gpu: "AMD Radeon RX 9070 XT",
  cpu: "AMD Ryzen 7 9800X3D",
  gpuVendor: "amd",
  ramGb: 32,
  os: "SteamOS 3.7.13",
  gpuDriver: "Mesa 26.1.4",
};

describe("deferToCapture (§23.2)", () => {
  it("keeps Mesa's version string out of the override", () => {
    const override = deferToCapture(DECLARED, FROM_CAPTURE);
    expect(override.gpuDriver).toBeUndefined();
    // The kernel module name must not reach the run, and it must not look like a
    // Mesa version either.
    expect(Object.values(override)).not.toContain("amdgpu (kernel 6.11.11-valve)");
  });

  it("keeps the fields only the client can see", () => {
    const override = deferToCapture(DECLARED, FROM_CAPTURE);
    // MangoHud reports neither, and both are real diagnostics inputs.
    expect(override.gpuVramTotalMb).toBe(16368);
    expect(override.resolution).toBe("2560x1440");
  });

  it("never lets the placeholder GPU name beat a real one", () => {
    const override = deferToCapture(DECLARED, FROM_CAPTURE);
    expect(override.gpu).toBeUndefined();
  });

  it("is a no-op when the capture declares no hardware at all", () => {
    // PresentMon's CSV carries none, so the Windows path is unchanged: the
    // client's reads are the only source there is.
    expect(deferToCapture(DECLARED, undefined)).toEqual(DECLARED);
    expect(deferToCapture(DECLARED, {})).toEqual(DECLARED);
  });

  it("an explicitly-undefined capture field is not an answer to defer to", () => {
    // Deferring to it would delete a value the client did know, leaving the run
    // with neither.
    const override = deferToCapture(DECLARED, { gpuDriver: undefined, gpu: "RX 9070 XT" });
    expect(override.gpuDriver).toBe("amdgpu (kernel 6.11.11-valve)");
    expect(override.gpu).toBeUndefined();
  });

  it("does not mutate the snapshot it was given", () => {
    const before = { ...DECLARED };
    deferToCapture(DECLARED, FROM_CAPTURE);
    expect(DECLARED).toEqual(before);
  });
});
