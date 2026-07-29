/**
 * Vendor the three design-system webfont faces into src/assets/fonts (§21.1).
 *
 * The web hub gets its faces from `next/font/google`; the desktop webview has
 * no such loader and must not reach the network at runtime, so the WOFF2 files
 * are committed to the repo and this script is the documented way to
 * regenerate them. Skipping this silently breaks the "all numerics in tabular
 * JetBrains Mono" invariant on every user machine.
 *
 * Each file is verified against the checksum recorded in fonts.lock.json. Run
 * with --update to re-record checksums after a deliberate font refresh.
 *
 * All three faces are SIL Open Font License 1.1 — see LICENSES.md.
 *
 *   node scripts/fetch-fonts.mjs [--update]
 */

import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FONT_DIR = path.join(HERE, "..", "src", "assets", "fonts");
const LOCK_FILE = path.join(HERE, "fonts.lock.json");

// Chrome UA: the Google Fonts CSS API serves WOFF2 only to browsers that
// advertise support. With Node's default UA it hands back TTF.
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

/** family → the weights the design system actually uses. */
const FACES = [
  { family: "Space Grotesk", file: "space-grotesk", weights: [400, 500, 600, 700] },
  { family: "Hanken Grotesk", file: "hanken-grotesk", weights: [400, 500, 600, 700] },
  { family: "JetBrains Mono", file: "jetbrains-mono", weights: [400, 500, 600, 700] },
];

async function cssFor(family, weights) {
  const url =
    `https://fonts.googleapis.com/css2?family=${encodeURIComponent(family)}` +
    `:wght@${weights.join(";")}&display=swap`;
  const response = await fetch(url, { headers: { "user-agent": UA } });
  if (!response.ok) throw new Error(`${family}: font CSS request failed (${response.status})`);
  return response.text();
}

/**
 * Pull the latin (not latin-ext) variable-font URL. Google serves one WOFF2
 * per unicode-range; latin covers every glyph the product UI ships.
 */
function latinWoff2(css, family) {
  const blocks = css.split("@font-face").slice(1);
  for (const block of blocks) {
    if (!/unicode-range:[^;]*U\+0000-00FF/.test(block)) continue;
    const match = /src:\s*url\((https:[^)]+\.woff2)\)/.exec(block);
    if (match) return match[1];
  }
  throw new Error(`${family}: no latin WOFF2 in the served CSS`);
}

const update = process.argv.includes("--update");
const lock = JSON.parse(await readFile(LOCK_FILE, "utf8").catch(() => "{}"));

await mkdir(FONT_DIR, { recursive: true });
for (const face of FACES) {
  const name = `${face.file}.woff2`;
  const url = latinWoff2(await cssFor(face.family, face.weights), face.family);
  const bytes = new Uint8Array(await (await fetch(url, { headers: { "user-agent": UA } })).arrayBuffer());
  const digest = createHash("sha256").update(bytes).digest("hex");

  if (lock[name] && lock[name] !== digest && !update) {
    throw new Error(
      `${name}: checksum ${digest} does not match the pinned ${lock[name]}. ` +
        `Re-run with --update only if the font refresh is intentional.`,
    );
  }
  lock[name] = digest;
  await writeFile(path.join(FONT_DIR, name), bytes);
  console.log(`${name}  ${bytes.byteLength} bytes  sha256:${digest.slice(0, 16)}…`);
}

await writeFile(LOCK_FILE, `${JSON.stringify(lock, null, 2)}\n`);
console.log(`Wrote ${FACES.length} faces to src/assets/fonts and updated fonts.lock.json.`);
