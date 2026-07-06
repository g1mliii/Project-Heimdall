import { describe, expect, it } from "vitest";

import { buildHeaderMap, detectDialect, findColumn, parseLocaleNumber, splitCsvLine } from "./csv";
import { decodeInput, splitLines } from "./decode";

const BOM = String.fromCharCode(0xfeff);

describe("decodeInput", () => {
  it("passes strings through and strips a BOM", () => {
    expect(decodeInput("abc")).toBe("abc");
    expect(decodeInput(BOM + "abc")).toBe("abc");
  });

  it("decodes UTF-8 bytes, including a byte-level BOM", () => {
    const bytes = new TextEncoder().encode(BOM + "MsBetweenPresents\n8,3");
    expect(decodeInput(bytes)).toBe("MsBetweenPresents\n8,3");
  });

  it("never throws on invalid bytes (lossy decode)", () => {
    const garbage = new Uint8Array([0xef, 0xbb, 0x00, 0x80, 0xc3]);
    expect(() => decodeInput(garbage)).not.toThrow();
  });

  it("decodes UTF-16 via BOM sniff (PowerShell `>` writes UTF-16LE)", () => {
    const text = "FrameTime\n10";
    const le = new Uint8Array(2 + text.length * 2);
    const be = new Uint8Array(2 + text.length * 2);
    le[0] = 0xff; le[1] = 0xfe;
    be[0] = 0xfe; be[1] = 0xff;
    for (let i = 0; i < text.length; i++) {
      const code = text.charCodeAt(i);
      le[2 + i * 2] = code & 0xff; le[3 + i * 2] = code >> 8;
      be[2 + i * 2] = code >> 8; be[3 + i * 2] = code & 0xff;
    }
    expect(decodeInput(le)).toBe(text);
    expect(decodeInput(be)).toBe(text);
  });
});

describe("splitLines", () => {
  it("handles LF and CRLF, dropping trailing blank lines only", () => {
    expect(splitLines("a\r\nb\n\nc\n\n")).toEqual(["a", "b", "", "c"]);
    expect(splitLines("")).toEqual([]);
    expect(splitLines("  \n\t\n")).toEqual([]);
  });
});

describe("detectDialect (§7.2)", () => {
  it("detects the German-style semicolon + decimal-comma dialect", () => {
    expect(detectDialect("TimeInSeconds;MsBetweenPresents")).toEqual({
      delimiter: ";",
      decimal: ",",
    });
  });

  it("defaults to comma + decimal dot", () => {
    expect(detectDialect("TimeInSeconds,MsBetweenPresents")).toEqual({
      delimiter: ",",
      decimal: ".",
    });
  });
});

describe("splitCsvLine", () => {
  it("splits plain cells", () => {
    expect(splitCsvLine("a,b,,d", ",")).toEqual(["a", "b", "", "d"]);
  });

  it("respects quoted cells with embedded delimiters and escaped quotes", () => {
    expect(splitCsvLine('"a,b",c,"say ""hi"""', ",")).toEqual(['a,b', "c", 'say "hi"']);
  });

  it("splits on semicolons when asked", () => {
    expect(splitCsvLine("1,5;2,5", ";")).toEqual(["1,5", "2,5"]);
  });
});

describe("parseLocaleNumber", () => {
  const dot = { delimiter: ",", decimal: "." } as const;
  const comma = { delimiter: ";", decimal: "," } as const;

  it("parses under both decimal conventions", () => {
    expect(parseLocaleNumber("8.35", dot)).toBe(8.35);
    expect(parseLocaleNumber("8,35", comma)).toBe(8.35);
    expect(parseLocaleNumber(" 12 ", dot)).toBe(12);
  });

  it("strips dot grouping when a decimal comma is present", () => {
    expect(parseLocaleNumber("1.234,5", comma)).toBe(1234.5);
    expect(parseLocaleNumber("11.500,25", comma)).toBe(11500.25);
    // Dot-only cells are ambiguous (grouping vs decimal) — face value wins.
    expect(parseLocaleNumber("11.500", comma)).toBe(11.5);
  });

  it("returns undefined (never NaN) on garbage, empty, NA, or Infinity", () => {
    for (const raw of ["", "  ", "NA", "abc", "12abc", "Infinity", "-Infinity", "NaN"]) {
      expect(parseLocaleNumber(raw, dot), raw).toBeUndefined();
    }
    expect(parseLocaleNumber(undefined, dot)).toBeUndefined();
  });
});

describe("buildHeaderMap / findColumn", () => {
  it("is case-insensitive and alias-driven", () => {
    const header = buildHeaderMap([" MsBetweenPresents ", "TimeInSeconds", "GpuUsage"]);
    expect(findColumn(header, ["msbetweenpresents"])).toBe(0);
    expect(findColumn(header, ["nope", "gpuusage"])).toBe(2);
    expect(findColumn(header, ["missing"])).toBeUndefined();
  });

  it("keeps the first occurrence on duplicate headers", () => {
    const header = buildHeaderMap(["A", "a"]);
    expect(header.get("a")).toBe(0);
  });
});
