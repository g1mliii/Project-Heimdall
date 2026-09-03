# Tauri config layout (§24.1)

Four config files, and the split is load-bearing. `tauri-build` rejects any
unknown key — including a `"//"` comment — so this explanation lives here rather
than inside the JSON. The split itself is pinned by
`apps/desktop/src/lib/release-config.test.ts`.

| File | Applied | Holds |
| --- | --- | --- |
| `tauri.conf.json` | always | window, CSP, icons, resources, product metadata |
| `tauri.windows.conf.json` | auto-merged on Windows | `externalBin`, `targets: ["nsis"]`, `windows.nsis` |
| `tauri.linux.conf.json` | auto-merged on Linux | `targets: ["appimage", "deb"]`, `linux.deb.depends` |
| `tauri.release.conf.json` | `--config`, release workflow only | updater endpoint + pubkey, Authenticode `signCommand` |

## Why the platform split exists

Not tidiness — it unblocks the Linux build.

`bundle.externalBin` is validated by `tauri-build` at **build-script** time. With
`binaries/presentmon` in the shared config, `cargo clippy` itself failed on Linux
with `resource path ... doesn't exist`: the sidecar is a Win32 executable, and
`scripts/fetch-presentmon.mjs` deliberately never places one on a Linux runner
(the Linux client bundles no capture tool — it watches the user's own MangoHud,
§23.1). `targets` and `windows.nsis` had the same problem for the same reason.

Two things to know when editing these:

- **Tauri replaces arrays rather than appending them.** Each platform file states
  its complete `targets` list; there is no inheritance to rely on.
- **`tauri.release.conf.json` layers on top of the platform file, not instead of
  it.** Its `bundle.windows.signCommand` is inert on Linux, which is why one
  release overlay serves both.

## Why the release overlay is separate

`plugins.updater.pubkey` must be a real key or the build fails, and
`signCommand` needs Azure Trusted Signing credentials that only exist in CI.
Keeping both out of the shared config means a contributor runs `cargo tauri
build` with no secrets at all and still gets a working — unsigned,
non-updating — installer.

**Three distinct keys**, documented in `docs/desktop-client.md`. They are not
interchangeable and must never be reused across roles:

1. Authenticode certificate → installer trust (`signCommand`)
2. Tauri updater keypair → update-manifest trust (`pubkey`)
3. Ed25519 payload key → §22.3 upload tamper-evidence (build env var)

## Flatpak

Not a Tauri target. `../flatpak/dev.heimdall.capture.yml` is a separate manifest,
and its sandbox grants — read-only access to MangoHud's config and log folders —
are the substantive part. See that file's header.
