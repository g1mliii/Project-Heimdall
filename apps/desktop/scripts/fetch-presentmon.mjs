/**
 * Fetch the pinned Intel PresentMon build into src-tauri/binaries (§21.2).
 *
 * The sidecar is NOT committed — a ~900 KB vendor binary in git is a poor
 * trade. Instead the exact release is pinned here and verified against a
 * SHA-256 that IS committed, so "what shipped" is reproducible and a
 * compromised or swapped upstream asset fails the build loudly. Run in dev
 * setup and in CI before `cargo tauri build`.
 *
 * Tauri's `bundle.externalBin` expects the target triple in the file name; it
 * strips the suffix when bundling, so the installed sidecar is `presentmon.exe`
 * next to the app binary.
 *
 * PresentMon is MIT-licensed and redistributed unmodified — see
 * src-tauri/LICENSES.md.
 *
 *   node scripts/fetch-presentmon.mjs [--force]
 */

import { createHash } from "node:crypto";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Pinned release. Keep in lockstep with `PRESENTMON_VERSION` in
 * src-tauri/src/presentmon.rs — that constant is what the run's capture
 * provenance records (§2.2), so a silent drift here would mislabel every
 * capture. The check at the bottom of this file enforces it.
 */
const VERSION = "2.4.1";
const ASSET = `PresentMon-${VERSION}-x64.exe`;
const URL = `https://github.com/GameTechDev/PresentMon/releases/download/v${VERSION}/${ASSET}`;
const SHA256 = "d74183e7ae630f72cd3690be0373ecbfdc6cbb86578148aab8fa2a7166068f34";

/** Tauri resolves the sidecar by this exact name. Windows x64 is the only target. */
const TARGET_TRIPLE = "x86_64-pc-windows-msvc";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.join(HERE, "..", "src-tauri", "binaries");
const OUT_FILE = path.join(OUT_DIR, `presentmon-${TARGET_TRIPLE}.exe`);

async function digestOf(file) {
  try {
    return createHash("sha256").update(await readFile(file)).digest("hex");
  } catch {
    return null;
  }
}

async function assertVersionPinsAgree() {
  const rust = await readFile(path.join(HERE, "..", "src-tauri", "src", "presentmon.rs"), "utf8");
  const match = /PRESENTMON_VERSION: &str = "([^"]+)"/.exec(rust);
  if (match?.[1] !== VERSION) {
    throw new Error(
      `version pin drift: this script fetches ${VERSION} but presentmon.rs records ` +
        `${match?.[1] ?? "nothing"} as the capture provenance. Update both.`,
    );
  }
}

await assertVersionPinsAgree();

if (!process.argv.includes("--force") && (await digestOf(OUT_FILE)) === SHA256) {
  console.log(`PresentMon ${VERSION} already present and verified.`);
  process.exit(0);
}

console.log(`Fetching ${URL}`);
const response = await fetch(URL, { headers: { "user-agent": "heimdall-desktop-build" } });
if (!response.ok) {
  throw new Error(`download failed: ${response.status} ${response.statusText}`);
}
const bytes = new Uint8Array(await response.arrayBuffer());
const digest = createHash("sha256").update(bytes).digest("hex");

if (digest !== SHA256) {
  // Never fall back to "install it anyway". An unexpected checksum means the
  // pinned asset is not what shipped when this pin was recorded.
  throw new Error(
    `checksum mismatch for ${ASSET}\n  expected ${SHA256}\n  actual   ${digest}\n` +
      `Refusing to install. If the pin is being moved deliberately, update VERSION ` +
      `and SHA256 together (and PRESENTMON_VERSION in src-tauri/src/presentmon.rs).`,
  );
}

await mkdir(OUT_DIR, { recursive: true });
await writeFile(OUT_FILE, bytes);
await chmod(OUT_FILE, 0o755);
console.log(`PresentMon ${VERSION} → ${path.relative(process.cwd(), OUT_FILE)} (sha256 verified)`);
