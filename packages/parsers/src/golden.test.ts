import { describe, expect, it } from "vitest";

import { parseCapture } from "./parse";
import { computeRunSummary } from "./metrics";
import { listFixtureFiles, readFixture, readFixtureJson } from "./testing/fixtures";
import { expectClose } from "./testing/assertions";

interface GoldenExpectation {
  summary: Record<string, unknown>;
  sampleCount: number;
  firstFrame: Record<string, unknown>;
  lastFrame: Record<string, unknown>;
  hardware?: Record<string, unknown>;
}

const allFiles = listFixtureFiles();
const parseable = allFiles.filter(
  (file) =>
    !file.startsWith("malformed/") &&
    file !== "README.md" &&
    !file.endsWith(".expected.json"),
);

describe("golden fixtures (§10.1) — every parseable fixture has a hand-computed expectation", () => {
  it("found the fixture tree", () => {
    expect(parseable.length).toBeGreaterThanOrEqual(9);
  });

  for (const file of parseable) {
    it(file, () => {
      const expectedPath = file.replace(/\.[^./]+$/, ".expected.json");
      // A parseable fixture without a colocated expected file fails the suite.
      expect(allFiles, `missing ${expectedPath}`).toContain(expectedPath);
      const expected = readFixtureJson(expectedPath) as GoldenExpectation;

      const source = file.split("/")[0]!;
      if (source !== "capframex" && source !== "presentmon" && source !== "mangohud") {
        throw new Error(`fixture dir ${source} has no parser`);
      }
      const result = parseCapture(source, readFixture(file));
      if (!result.ok) throw new Error(`${file}: ${result.error.code} — ${result.error.message}`);

      const { frames, hardware } = result.value;
      expect(frames).toHaveLength(expected.sampleCount);
      expectClose(frames[0], expected.firstFrame, "firstFrame");
      expectClose(frames[frames.length - 1], expected.lastFrame, "lastFrame");
      expectClose(computeRunSummary(frames), expected.summary, "summary");

      if (expected.hardware === undefined) expect(hardware).toBeUndefined();
      else expectClose(hardware, expected.hardware, "hardware");
    });
  }
});
