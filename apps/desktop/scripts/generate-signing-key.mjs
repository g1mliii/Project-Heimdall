/**
 * Generate the Ed25519 payload-signing keypair (§22.3).
 *
 * This is key #1 of the three the desktop client involves — the one that signs
 * uploaded frame Parquet. It is NOT the Tauri updater keypair (`tauri signer
 * generate`) and NOT the Authenticode certificate. See docs/desktop-client.md.
 *
 * Node's crypto is used rather than `openssl` so this works on a stock Windows
 * box, and the two halves come out in exactly the encodings each side expects:
 *
 *   private → base64 PKCS#8 DER  → HEIMDALL_SIGNING_PRIVATE_KEY (build secret)
 *   public  → base64 SPKI   DER  → HEIMDALL_SIGNING_PUBLIC_KEY  (server env)
 *
 * The private key is written to a FILE, never printed, so it does not end up in
 * a terminal scrollback or a screen recording. The public half is printed —
 * it is publishable by design, and publishing it is what lets anyone verify a
 * run's signature without trusting us.
 *
 *   node scripts/generate-signing-key.mjs [--out <path>]
 */

import { generateKeyPairSync } from "node:crypto";
import { chmod, writeFile } from "node:fs/promises";
import path from "node:path";

const outIndex = process.argv.indexOf("--out");
const outPath = path.resolve(
  outIndex === -1 ? "heimdall-signing-key.txt" : (process.argv[outIndex + 1] ?? ""),
);

if (path.relative(process.cwd(), outPath).startsWith("..") === false) {
  // Refuse to drop a private key inside the repository, where the next
  // `git add -A` would commit it.
  const inRepo = !path.relative(process.cwd(), outPath).startsWith("..");
  if (inRepo && !process.argv.includes("--i-know")) {
    console.error(
      `Refusing to write a private key to ${outPath} — that is inside the working tree.\n` +
        `Pass --out with a path outside the repo (e.g. --out ~/heimdall-signing-key.txt),\n` +
        `or --i-know if you have verified it is git-ignored.`,
    );
    process.exit(1);
  }
}

const { publicKey, privateKey } = generateKeyPairSync("ed25519");

const privateBase64 = privateKey.export({ format: "der", type: "pkcs8" }).toString("base64");
const publicBase64 = publicKey.export({ format: "der", type: "spki" }).toString("base64");

await writeFile(
  outPath,
  [
    "# Heimdall desktop payload-signing key (Ed25519, §22.3).",
    "# KEEP THE PRIVATE HALF SECRET. Paste it into the repository secret",
    "# HEIMDALL_SIGNING_PRIVATE_KEY, then delete this file.",
    "",
    `HEIMDALL_SIGNING_PRIVATE_KEY=${privateBase64}`,
    "",
    "# Publishable. Set this on the server so it can verify uploads.",
    `HEIMDALL_SIGNING_PUBLIC_KEY=${publicBase64}`,
    "",
  ].join("\n"),
  { mode: 0o600 },
);
// Best-effort on Windows, where mode is largely advisory.
await chmod(outPath, 0o600).catch(() => {});

console.log(`Private key written to ${outPath} (not printed here).`);
console.log("");
console.log("Public key — this is HEIMDALL_SIGNING_PUBLIC_KEY on the server:");
console.log("");
console.log(`  ${publicBase64}`);
console.log("");
console.log("Next:");
console.log("  1. Copy HEIMDALL_SIGNING_PRIVATE_KEY from the file into the repo secret.");
console.log("  2. Set HEIMDALL_SIGNING_PUBLIC_KEY above on the server.");
console.log("  3. Delete the file.");
console.log("");
console.log("Losing the private key is recoverable: generate a new pair and update both");
console.log("sides. Runs signed with the old key then record signature_valid: false, which");
console.log("is evidence only and never affects whether they are accepted (§0.5).");
