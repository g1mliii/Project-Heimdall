/**
 * Test-only recursive tolerant comparison: numbers compare with toBeCloseTo
 * (golden expected values are hand-computed decimals, parser output is IEEE
 * float arithmetic), everything else compares exactly, and key sets must match.
 */

import { expect } from "vitest";

import type { ParseResult } from "../errors";

/** Narrow a ParseResult to its success arm, failing loudly with the error. */
export function unwrapOk<T>(result: ParseResult<T>): Extract<ParseResult<T>, { ok: true }> {
  if (!result.ok) {
    throw new Error(`expected ok, got ${result.error.code}: ${result.error.message}`);
  }
  return result;
}

export function expectClose(actual: unknown, expected: unknown, path = "$"): void {
  if (typeof expected === "number" && typeof actual === "number") {
    expect(actual, path).toBeCloseTo(expected, 6);
    return;
  }
  if (Array.isArray(expected)) {
    expect(Array.isArray(actual), path).toBe(true);
    expect((actual as unknown[]).length, path).toBe(expected.length);
    expected.forEach((item, i) => expectClose((actual as unknown[])[i], item, `${path}[${i}]`));
    return;
  }
  if (typeof expected === "object" && expected !== null) {
    expect(typeof actual, path).toBe("object");
    const actualObj = actual as Record<string, unknown>;
    const expectedObj = expected as Record<string, unknown>;
    expect(Object.keys(actualObj).sort(), path).toEqual(Object.keys(expectedObj).sort());
    for (const key of Object.keys(expectedObj)) {
      expectClose(actualObj[key], expectedObj[key], `${path}.${key}`);
    }
    return;
  }
  expect(actual, path).toEqual(expected);
}
