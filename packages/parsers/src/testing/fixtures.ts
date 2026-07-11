/**
 * Test-only fixture IO. Lives under src/testing/ which is exempt from the
 * isomorphism lint (tests run on Node only); nothing here is exported from the
 * package barrel. Fixtures are returned as bytes so tests exercise the full
 * decode path (BOM/UTF-8 handling), not just the string fast path.
 */

import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, relative } from "node:path";

export const FIXTURES_DIR = fileURLToPath(new URL("../../fixtures/", import.meta.url));

export function readFixture(relPath: string): Uint8Array {
  return new Uint8Array(readFileSync(join(FIXTURES_DIR, relPath)));
}

export function readFixtureText(relPath: string): string {
  return readFileSync(join(FIXTURES_DIR, relPath), "utf8");
}

export function readFixtureJson(relPath: string): unknown {
  return JSON.parse(readFixtureText(relPath));
}

/** Recursively list fixture files, as fixture-relative POSIX paths. */
export function listFixtureFiles(subdir = "."): string[] {
  const results: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else results.push(relative(FIXTURES_DIR, full).replaceAll("\\", "/"));
    }
  };
  walk(join(FIXTURES_DIR, subdir));
  return results.sort();
}
