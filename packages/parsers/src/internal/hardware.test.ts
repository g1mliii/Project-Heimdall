import { describe, expect, it } from "vitest";
import { parseVramTotalMb } from "./hardware";

describe("parseVramTotalMb", () => {
  it("reads unit-tagged strings", () => {
    expect(parseVramTotalMb("12288 MB")).toBe(12_288);
    expect(parseVramTotalMb("12,288 MB")).toBe(12_288);
    expect(parseVramTotalMb("12 GB")).toBe(12_288);
    expect(parseVramTotalMb("16 GiB")).toBe(16_384);
  });

  it("disambiguates bare numbers by magnitude (GB / MB / KB / bytes)", () => {
    expect(parseVramTotalMb(12)).toBe(12_288); // small → GB
    expect(parseVramTotalMb(12_288)).toBe(12_288); // MB scale
    expect(parseVramTotalMb("8")).toBe(8_192);
    expect(parseVramTotalMb(12_582_912)).toBe(12_288); // KB scale (12288 * 1024)
    expect(parseVramTotalMb(12_884_901_888)).toBe(12_288); // byte scale (12 GiB)
  });

  it("rejects unusable input", () => {
    expect(parseVramTotalMb(undefined)).toBeUndefined();
    expect(parseVramTotalMb(0)).toBeUndefined();
    expect(parseVramTotalMb(-4)).toBeUndefined();
    expect(parseVramTotalMb("n/a")).toBeUndefined();
    expect(parseVramTotalMb("NVIDIA GeForce RTX 4090 24 GB")).toBeUndefined();
    expect(parseVramTotalMb({})).toBeUndefined();
  });

  it("rejects implausible capacities rather than emitting garbage", () => {
    expect(parseVramTotalMb(64)).toBe(65_536); // 64 GB — plausible, kept
    expect(parseVramTotalMb(255)).toBeUndefined(); // 255 MB → below the VRAM floor
    expect(parseVramTotalMb("500000 MB")).toBeUndefined(); // unit-tagged but > 256 GB
    expect(parseVramTotalMb(1e15)).toBeUndefined(); // absurd in every unit
  });
});
