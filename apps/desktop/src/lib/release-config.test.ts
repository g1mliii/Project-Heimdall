import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = path.resolve(process.cwd(), "../..");
const read = (relative: string) => readFileSync(path.join(root, relative), "utf8");

describe("desktop release hardening", () => {
  it("pins the credential-bearing signing tool and enables the updater code path", () => {
    const workflow = read(".github/workflows/release.yml");
    expect(workflow).toContain(
      "cargo install artifact-signing-cli --version 0.11.0 --locked",
    );
    expect(workflow).toContain("tauri build --features release-updates");
    expect(workflow).toContain("HEIMDALL_R2_ACCOUNT_ID");
    expect(workflow).toContain("HEIMDALL_R2_BUCKET");
  });

  it("does not grant direct opener or updater plugin commands to the webview", () => {
    const capability = JSON.parse(
      read("apps/desktop/src-tauri/capabilities/default.json"),
    ) as { permissions: Array<string | { identifier: string }> };
    expect(capability.permissions).not.toContain("opener:default");
    expect(capability.permissions).not.toContain("updater:default");
  });

  it("selects a release-only capability with no localhost HTTP access", () => {
    const releaseCapability = JSON.parse(
      read("apps/desktop/src-tauri/release-capability.json"),
    ) as {
      identifier: string;
      permissions: Array<string | { identifier: string; allow?: Array<{ url: string }> }>;
    };
    const workflow = read(".github/workflows/release.yml");
    const selector = read("apps/desktop/scripts/select-release-capability.mjs");
    const http = releaseCapability.permissions.find(
      (permission) => typeof permission !== "string" && permission.identifier === "http:default",
    );
    const urls =
      typeof http === "object" && http !== null ? (http.allow ?? []).map(({ url }) => url) : [];

    expect(releaseCapability.identifier).toBe("default");
    expect(urls).toContain("https://heimdall.dev/*");
    expect(urls.some((url) => new URL(url.replace("*", "")).hostname === "localhost")).toBe(false);
    expect(workflow).toContain("node apps/desktop/scripts/select-release-capability.mjs");
    expect(selector).toContain('process.env.HEIMDALL_RELEASE_BUILD !== "true"');
  });

  it("embeds a generated Minisign public key in the release updater config", () => {
    const releaseConfig = JSON.parse(
      read("apps/desktop/src-tauri/tauri.release.conf.json"),
    ) as { plugins: { updater: { pubkey: string } } };
    const encodedPublicKey = releaseConfig.plugins.updater.pubkey;

    expect(encodedPublicKey).toMatch(/^[A-Za-z0-9+/]+={0,2}$/);
    expect(Buffer.from(encodedPublicKey, "base64").toString("utf8")).toMatch(
      /^untrusted comment: minisign public key: [A-F0-9]{16}\nRW[A-Za-z0-9+/]{54}\n$/,
    );
  });
});
