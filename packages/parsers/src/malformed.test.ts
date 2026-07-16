import { describe, expect, it } from "vitest";
import { captureSourceSchema, type CaptureSource } from "@heimdall/shared";

import { parseCapture } from "./parse";
import type { ParseErrorCode } from "./errors";
import { readFixture } from "./testing/fixtures";
import { makeLcg } from "./testing/rng";

const ERROR_CODES: readonly ParseErrorCode[] = [
  "empty-input",
  "unrecognized-format",
  "missing-columns",
  "invalid-json",
  "no-valid-frames",
  "too-many-frames",
  "too-many-bad-rows",
  "too-many-streams",
];

const SOURCES = captureSourceSchema.options;

/** fixture → per-source expected error code (§10.3). */
const CASES: { fixture: string; expect: Partial<Record<CaptureSource, ParseErrorCode>> }[] = [
  {
    fixture: "malformed/empty.csv",
    expect: { capframex: "empty-input", presentmon: "empty-input", mangohud: "empty-input" },
  },
  {
    fixture: "malformed/header-only.csv",
    // Valid header, zero data rows — for both parsers that recognize it.
    expect: { capframex: "no-valid-frames", presentmon: "no-valid-frames" },
  },
  {
    fixture: "malformed/truncated-rows.csv",
    // 3 of 20 rows lack the frame-time cell → 15% > the 5% tolerance.
    expect: { capframex: "too-many-bad-rows", presentmon: "too-many-bad-rows" },
  },
  {
    fixture: "malformed/binary-garbage.bin",
    expect: {
      capframex: "unrecognized-format",
      presentmon: "unrecognized-format",
      mangohud: "unrecognized-format",
    },
  },
  {
    fixture: "malformed/wrong-format.csv",
    // CSV-shaped but not a capture log: delimiters exist, frame-time column doesn't.
    expect: {
      capframex: "missing-columns",
      presentmon: "missing-columns",
      mangohud: "missing-columns",
    },
  },
  {
    fixture: "malformed/capframex-bad.json",
    expect: { capframex: "invalid-json" },
  },
  {
    fixture: "malformed/negative-frametimes.csv",
    // Every row is non-positive → zero survivors.
    expect: { capframex: "no-valid-frames", presentmon: "no-valid-frames" },
  },
];

describe("malformed fixtures → typed errors, never a crash (§10.3)", () => {
  for (const testCase of CASES) {
    for (const [source, code] of Object.entries(testCase.expect) as [
      CaptureSource,
      ParseErrorCode,
    ][]) {
      it(`${testCase.fixture} → ${code} (${source})`, () => {
        const result = parseCapture(source, readFixture(testCase.fixture));
        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error.code).toBe(code);
          expect(result.error.source).toBe(source);
          expect(result.error.message.length).toBeGreaterThan(0);
        }
      });
    }
  }
});

describe("out-of-union source strings (DB/queue boundary casts)", () => {
  it("returns a typed failure instead of throwing or returning undefined", () => {
    const result = parseCapture("fraps", "MsBetweenPresents\n10");
    expect(result).toMatchObject({
      ok: false,
      error: { code: "unrecognized-format", source: "unknown" },
    });
    if (!result.ok) expect(result.error.message).toContain("fraps");
  });
});

describe("random bytes never escape the result union (seeded LCG)", () => {
  it("returns a well-formed ParseResult for 100 random buffers per source", () => {
    const rand = makeLcg(0xdecafbad);

    for (let iteration = 0; iteration < 100; iteration++) {
      const bytes = new Uint8Array(Math.floor(rand() * 2048));
      for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(rand() * 256);

      for (const source of SOURCES) {
        const label = `iteration ${iteration}, ${source}`;
        const result = parseCapture(source, bytes); // must not throw
        if (result.ok) {
          expect(result.value.frames.length, label).toBeGreaterThan(0);
          for (const frame of result.value.frames) {
            expect(frame.frameTimeMs, label).toBeGreaterThan(0);
          }
        } else {
          expect(ERROR_CODES, label).toContain(result.error.code);
        }
      }
    }
  });
});
