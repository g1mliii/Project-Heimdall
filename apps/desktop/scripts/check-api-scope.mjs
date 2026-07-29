/**
 * Assert the baked-in hub origin is reachable under the webview's HTTP
 * capability scope (§22.5).
 *
 * Two independent places have to agree about which origin this build talks to:
 *
 * * `HEIMDALL_API_BASE_URL`, compiled into the binary by `upload::api_base_url`
 * * `capabilities/default.json` → `http:default`, which is what actually lets
 *   `tauri-plugin-http` issue the request
 *
 * Nothing connects them, and a mismatch is invisible until a real user presses
 * Upload and gets a permission error from the plugin — no test, no CI job and
 * no local run reaches it, because local builds default to localhost, which IS
 * in the scope. Note `https://*.heimdall.dev/*` does NOT match an apex
 * `https://heimdall.dev`: the wildcard needs a label to eat.
 *
 * So this runs before every bundle and fails the build instead.
 *
 *   node scripts/check-api-scope.mjs
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CAPABILITY_FILE = path.join(HERE, "..", "src-tauri", "capabilities", "default.json");

/** Must match the default in `upload::api_base_url`. */
const DEFAULT_BASE_URL = "http://localhost:3000";

/** The `http:default` scope entries, as URL patterns. */
function allowedPatterns() {
  const capability = JSON.parse(readFileSync(CAPABILITY_FILE, "utf8"));
  const http = capability.permissions.find(
    (permission) => permission?.identifier === "http:default",
  );
  if (!http) {
    throw new Error(`${CAPABILITY_FILE}: no http:default permission — the webview cannot reach any origin`);
  }
  return (http.allow ?? []).map((entry) => entry.url);
}

/**
 * Does `pattern` admit `target`? Deliberately stricter than Tauri's matcher: a
 * false PASS here ships a broken client, while a false FAIL is a one-line scope
 * edit. Only the `*.host` form is treated as a wildcard, and it requires at
 * least one leading label — the case that actually bit.
 */
export function scopeAdmits(pattern, target) {
  let patternUrl;
  let targetUrl;
  try {
    patternUrl = new URL(pattern.replace("*.", "wildcard-label."));
    targetUrl = new URL(target);
  } catch {
    return false;
  }
  if (patternUrl.protocol !== targetUrl.protocol) return false;
  if (patternUrl.port !== targetUrl.port) return false;

  if (!pattern.includes("*.")) return patternUrl.hostname === targetUrl.hostname;
  const suffix = patternUrl.hostname.replace(/^wildcard-label\./, "");
  return targetUrl.hostname.endsWith(`.${suffix}`);
}

const baseUrl = (process.env.HEIMDALL_API_BASE_URL || DEFAULT_BASE_URL).trim().replace(/\/+$/, "");
const patterns = allowedPatterns();

if (!patterns.some((pattern) => scopeAdmits(pattern, baseUrl))) {
  throw new Error(
    `HEIMDALL_API_BASE_URL is ${baseUrl}, which no http:default scope entry admits:\n` +
      patterns.map((pattern) => `  ${pattern}`).join("\n") +
      `\nEvery upload from this build would fail with a permission error. Add the origin to ` +
      `src-tauri/capabilities/default.json (remember that https://*.example.com does not match ` +
      `https://example.com), or fix the base URL.`,
  );
}

console.log(`Hub origin ${baseUrl} is within the webview HTTP capability scope.`);
