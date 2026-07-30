/**
 * Replace the development capability with the production template immediately
 * before a release build. Tauri 2.6 automatically includes every file under
 * `capabilities/`, so the release template deliberately lives outside that
 * directory and is copied into the one selected slot only in ephemeral CI.
 */

import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

if (process.env.HEIMDALL_RELEASE_BUILD !== "true") {
  throw new Error("select-release-capability requires HEIMDALL_RELEASE_BUILD=true");
}

const here = path.dirname(fileURLToPath(import.meta.url));
const source = path.join(here, "..", "src-tauri", "release-capability.json");
const destination = path.join(here, "..", "src-tauri", "capabilities", "default.json");
const capability = JSON.parse(readFileSync(source, "utf8"));
const http = capability.permissions.find(
  (permission) => permission?.identifier === "http:default",
);
const urls = (http?.allow ?? []).map(({ url }) => url);

if (urls.some((url) => /(^|[/:])(localhost|127\.0\.0\.1|\[?::1\]?)([:/]|$)/i.test(url))) {
  throw new Error("release capability must not grant localhost HTTP access");
}

capability.$schema = "../gen/schemas/desktop-schema.json";
writeFileSync(destination, `${JSON.stringify(capability, null, 2)}\n`);
console.log("Selected the production-only Tauri capability.");
