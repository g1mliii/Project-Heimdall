import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { compareDriverVersions, normalizeDriverVersion } from "./gpu-driver-outdated";

const version = fc
  .array(fc.integer({ min: 0, max: 9_999 }), { minLength: 1, maxLength: 6 })
  .map((segments) => segments.join("."));

const sign = (value: number): number => Math.sign(value);

describe("driver version properties", () => {
  it("is reflexive and antisymmetric for numeric versions", () => {
    fc.assert(
      fc.property(version, version, (left, right) => {
        expect(compareDriverVersions(left, left)).toBe(0);
        expect(sign(compareDriverVersions(left, right))).toBe(
          -sign(compareDriverVersions(right, left)),
        );
      }),
    );
  });

  it("is transitive for ordered numeric versions", () => {
    fc.assert(
      fc.property(version, version, version, (a, b, c) => {
        if (compareDriverVersions(a, b) <= 0 && compareDriverVersions(b, c) <= 0) {
          expect(compareDriverVersions(a, c)).toBeLessThanOrEqual(0);
        }
      }),
    );
  });

  it("normalization is total for arbitrary capture strings", () => {
    fc.assert(
      fc.property(fc.string(), (capture) => {
        expect(() => normalizeDriverVersion(capture, "nvidia", "windows", "gpu")).not.toThrow();
        expect(() => normalizeDriverVersion(capture, "amd", "linux", "mesa")).not.toThrow();
      }),
    );
  });
});
