// Copy the design-system CSS + static assets into dist/, preserving the relative
// structure that styles.css's `@import url('tokens/…')` lines expect. Run after
// tsup (which emits the JS/d.ts and cleans dist/ first).
import { cpSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const pkgRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const src = join(pkgRoot, "src");
const dist = join(pkgRoot, "dist");

mkdirSync(join(dist, "components"), { recursive: true });

// Entry manifest + token files (tokens/*.css are referenced by styles.css).
cpSync(join(src, "styles.css"), join(dist, "styles.css"));
cpSync(join(src, "tokens"), join(dist, "tokens"), { recursive: true });
cpSync(join(src, "components", "components.css"), join(dist, "components", "components.css"));
cpSync(join(src, "assets"), join(dist, "assets"), { recursive: true });

console.log("copied styles.css, tokens/, components/components.css, assets/ → dist/");
