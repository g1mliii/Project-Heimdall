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

  it("keeps the Windows-only sidecar out of the shared config (§24.1)", () => {
    // `bundle.externalBin` is validated by tauri-build at build-script time, so
    // an entry in the SHARED config makes `cargo clippy` itself fail on Linux
    // with "resource path doesn't exist" — the sidecar is a Win32 executable
    // that fetch-presentmon.mjs deliberately never places there. This is the
    // regression that blocked the Linux build; pin it.
    const base = JSON.parse(read("apps/desktop/src-tauri/tauri.conf.json")) as {
      bundle: { externalBin?: unknown; targets?: unknown; windows?: unknown };
    };
    expect(base.bundle.externalBin).toBeUndefined();
    expect(base.bundle.targets).toBeUndefined();
    expect(base.bundle.windows).toBeUndefined();

    const windows = JSON.parse(read("apps/desktop/src-tauri/tauri.windows.conf.json")) as {
      bundle: { externalBin: string[]; targets: string[] };
    };
    expect(windows.bundle.externalBin).toEqual(["binaries/presentmon"]);
    expect(windows.bundle.targets).toEqual(["nsis"]);
  });

  it("bundles no capture tool on Linux, because MangoHud is the user's (§23.1)", () => {
    const linux = JSON.parse(read("apps/desktop/src-tauri/tauri.linux.conf.json")) as {
      bundle: { externalBin?: unknown; targets: string[]; linux: { deb: { depends: string[] } } };
    };
    // Heimdall injects no overlay of its own. Shipping one would contradict the
    // whole watcher model.
    expect(linux.bundle.externalBin).toBeUndefined();
    expect(linux.bundle.targets).toEqual(["appimage", "deb"]);
    // MangoHud is NOT a package dependency: its absence is a setup check, not a
    // reason a package manager should pull an overlay onto someone's machine.
    expect(linux.bundle.linux.deb.depends.join(" ")).not.toContain("mangohud");
  });

  it("skips the sidecar download off Windows but still checks the version pin", () => {
    const script = read("apps/desktop/scripts/fetch-presentmon.mjs");
    // Order matters: the pin check would be dead code on the Linux runner if it
    // sat below the platform skip, and a drift there mislabels the provenance of
    // every Windows capture.
    const pinCheck = script.indexOf("await assertVersionPinsAgree()");
    const skip = script.indexOf('process.platform !== "win32"');
    expect(pinCheck).toBeGreaterThan(-1);
    expect(skip).toBeGreaterThan(pinCheck);
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
