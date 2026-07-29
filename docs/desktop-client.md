# Heimdall Capture — desktop client

The Windows capture client (`apps/desktop`, Phase 9, §21–§22). Press a hotkey
in-game, get a shareable run report. It is a Tauri 2 shell around bundled Intel
PresentMon: Rust owns the sidecar, the hardware reads and the signing key; the
webview does all parsing and UI with the **same** `@heimdall/parsers` and
`@heimdall/ingest-client` code the web hub runs.

---

## Setup: Performance Log Users

PresentMon opens an ETW trace session. Without elevation that requires the
account to be in the built-in **Performance Log Users** group. Heimdall Capture
never asks for administrator rights; the one-time setup below is why.

The onboarding screen checks both of these and links here.

1. Open **Computer Management** (`Win+X` → Computer Management), or run
   `lusrmgr.msc`.
2. **Local Users and Groups** → **Groups** → double-click **Performance Log
   Users**.
3. **Add…** → type your account name → **Check Names** → **OK**.

Or from an elevated PowerShell:

```powershell
Add-LocalGroupMember -Group "Performance Log Users" -Member $env:USERNAME
```

4. **Sign out and back in.** Group membership is baked into the logon token, so
   it does not take effect until a new sign-in. The onboarding checklist calls
   this out as its own item because it is the step people skip.

On Windows Home editions `lusrmgr.msc` is absent; use the PowerShell command,
or `net localgroup "Performance Log Users" %USERNAME% /add` from an elevated
prompt.

If the check still fails, the client says so and lets you continue anyway — a
capture attempt reports the real error rather than the setup screen guessing.

---

## The bundled capture tool

| | |
|---|---|
| Tool | Intel PresentMon |
| Pinned version | **2.4.1** |
| Asset | `PresentMon-2.4.1-x64.exe` |
| SHA-256 | `d74183e7ae630f72cd3690be0373ecbfdc6cbb86578148aab8fa2a7166068f34` |
| Upstream | <https://github.com/GameTechDev/PresentMon/releases/tag/v2.4.1> |
| License | MIT — see `apps/desktop/src-tauri/LICENSES.md` |

The binary is **not committed**. `apps/desktop/scripts/fetch-presentmon.mjs`
downloads the pinned release and verifies that checksum before installing it,
and refuses outright on a mismatch. The script also asserts that its `VERSION`
matches `PRESENTMON_VERSION` in `src-tauri/src/presentmon.rs`, because that
constant is what every run records as its capture provenance (`captureTool`,
§2.2) — a silent drift would mislabel captures.

The version string is redistributed verbatim and shown in the UI.

### GPU telemetry is not available to this sidecar

`GPUUtilization` / `GPUFrequency` / `GPUPower` / `GPUMemUsed` do **not** appear
in console-CLI output, and no flag enables them. Tested on Windows 11 /
RX 9070 XT, three ways — the header ended at `ClickToPhotonLatency` every time:

| Configuration | Telemetry columns |
|---|---|
| Bundled 2.4.1 CLI, no service | no |
| Bundled 2.4.1 CLI, full MSI installed + `PresentMonSharedService` running | no |
| Intel's own 2.5.1 CLI from the MSI, service running | no |

`--help` on 2.5.1 is identical to 2.4.1 — there is no telemetry switch to find.
(`--track_hw_measurements` is for external LMT/PCAT hardware, not GPU sensors.)

Intel's own [console-app README][pm-console] agrees: the documented GPU metrics
are `MsGPULatency`, `MsGPUTime`, `MsGPUBusy`, `MsGPUWait` and `VideoBusy` — all
timing, no utilization, frequency, power or memory. Experiment and upstream
documentation say the same thing, so this is settled rather than a local quirk.

[pm-console]: https://github.com/GameTechDev/PresentMon/blob/main/README-ConsoleApplication.md

The columns belong to the **PresentMon UI application**, not the console tool.
Installing the full package therefore does not unlock them for us, so asking
users to install it would cost them an admin prompt and buy nothing. Not worth
revisiting without evidence that a console interface has been added upstream.

### Frame generation is invisible here too

`--track_frame_type` adds a `FrameType` column, and the client always passes it
— but its own help says it "requires application and/or driver instrumentation
using Intel-PresentMon provider", and AMD's driver does not emit that provider.

Verified: an RX 9070 XT running Cyberpunk 2077 with FSR **and frame generation
enabled** produced 14,241 rows, every single one labelled `Application`. The
frame-time distribution was unimodal (a tight 3–6 ms cluster), so the data does
not even reveal whether the generated frames are present in the stream.

**This has a real integrity consequence, and it is not currently solved.**
Measured on the same scene and settings with frame generation as the only
variable:

| | frames | duration | avg FPS | min frame time |
|---|---|---|---|---|
| FG on | 14,241 | 58.4 s | **243.9** | 0.32 ms |
| FG off | 7,839 | 60.0 s | **130.7** | 3.11 ms |

1.87x. The interpolated frames ARE in the present stream — PresentMon counts
them and labels every one `Application`. The pipeline then records
`generatedFrameTech: none`, because §11.5 derives it from the server's
recomputed `generatedFramePct`, which is 0. A declaration cannot override that:
`reconcileGeneratedFrameTech` treats a recomputed 0 as decisive, by design.

So a frame-generated run reports roughly double its real rendering rate, and its
1% lows and stutter counts are computed over interpolated frames.

**What was done about it.** The FPS figure cannot be corrected — the frames are
genuinely in the stream and nothing distinguishes them. What was fixed is the
false claim built on top:

- The parser now records `generated: false` when a frame-type column exists and
  reads `Application`, and leaves it `undefined` only when the format carries no
  such column. "We looked and saw none" and "we never looked" are different
  claims, and they used to collapse into the same all-null column.
- `reconcileGeneratedFrameTech` no longer returns `none` without evidence. With
  none, it takes the uploader's declaration, falling back to `unknown`.
- The Run details form (and the web upload page) ask for frame generation, since
  the capture cannot show it.

That does not make a frame-generated run's FPS honest, but it stops the run
claiming it was not frame-generated — so such runs no longer pool silently with
genuine ones. Making the FPS itself meaningful under frame generation is still
open.

So a frame-generated AMD run can pool with genuine non-generated runs in
comparability buckets. Distinguishing the two needs evidence we do not have.
Recorded rather than papered over; see IMPLEMENTATION_PLAN §22.11.

### GPU utilization and VRAM come from Windows instead

PresentMon does not supply them, so the client samples them itself, from Windows
performance counters (PDH) — no elevation, no vendor SDK, no extra install:

| Counter | Field |
|---|---|
| `\GPU Engine(*)\Utilization Percentage` | `gpuLoadPct` |
| `\GPU Process Memory(*)\Local Usage` | `vramUsedMb` |

Instance names embed the owning pid, so readings are attributed to the captured
game rather than to everything on the GPU. Only `engtype_3D` instances count
toward load — a process decoding video is not rendering frames. Samples are
appended to the capture stream as `HeimdallGpuUtilization` and
`HeimdallGpuMemUsedMb`, named so they can never be mistaken for PresentMon's own
output.

Two gotchas, both found the hard way and both pinned by tests:

- PDH writes `engtype_3D` with a **capital D**. PowerShell's `Get-Counter`
  lowercases instance names for display, so matching the shape you see in a
  console session finds nothing.
- PDH appends a disambiguation index to duplicated instances
  (`..._engtype_Compute 0`), so a 3D instance does not necessarily *end* in its
  engine type.

**These are polled, not frame-aligned.** A reading describes a ~200 ms interval,
not the frame it sits beside. The parser marks them `frameAligned: false`
(`presentmon@1.1.0`) and the per-frame `cpu-bottleneck` rule refuses them on that
basis. That is correct: do not "fix" it by claiming alignment we do not have.
They still feed the capability panel and the run report.

A frame arriving before the first sample gets empty cells, which the parser reads
as "no reading" — never as 0% load. If the counters cannot be opened at all, the
columns are omitted entirely rather than added and left blank.

GPU **clock** and **power** remain unavailable: PDH has no counters for them, and
they would need vendor SDKs (ADLX / NVML / IGCL).

A note on which process: a game renders in its foreground window process, which
is what the client targets. Browsers and Electron apps render in a GPU *child*
process, so their main-window pid legitimately reports no 3D instance — worth
knowing if you probe with one while testing.

### Moving the pin

PresentMon has renamed and inverted CLI flags across major releases (2.4 has no
`--track_gpu`; GPU work is tracked by default and `--no_track_gpu` turns it
off). When bumping:

1. Run `PresentMon-<new>-x64.exe --help` and re-read the flags.
2. Update `sidecar_args()` in `src-tauri/src/presentmon.rs` — the only place
   argv is constructed.
3. Update `PRESENTMON_VERSION`, and `VERSION` + `SHA256` in the fetch script.
4. Update the table above and `LICENSES.md`.

---

## What the client declares (§22.2)

Everything here is **declared** by the client, never inferred from frames — the
parsers are explicit that tool version, HAGS and rated memory speed cannot come
out of a capture file. This is what unlocks diagnostics no browser upload can
reach.

| Field | Source |
|---|---|
| `gpu`, `gpuVendor`, `gpuVramTotalMb` | DXGI `IDXGIAdapter1::GetDesc1` — description, vendor id, exact `DedicatedVideoMemory` bytes |
| `gpuDriver` | Registry `DriverVersion` (+ `RadeonSoftwareVersion`), normalized to the marketing string the driver-currency feed uses |
| `cpu` | WMI `Win32_Processor.Name` |
| `ramGb`, `ramSpeedMtps` | WMI `Win32_PhysicalMemory` — summed `Capacity`, minimum `ConfiguredClockSpeed` |
| `ramRatedSpeedMtps` | WMI `Speed`, **only when it exceeds the running speed** — see below |
| `os` | WMI `Win32_OperatingSystem.Caption` + build |
| `resolution` | `EnumDisplaySettingsW` on the monitor the game's window is on |
| `hags` (methodology) | `HKLM\SYSTEM\CurrentControlSet\Control\GraphicsDrivers\HwSchMode` — 2 enabled, 1 disabled, anything else unknown |
| `captureTool` (methodology) | The pinned PresentMon version, verbatim |

`canonicalGpuId` / `canonicalCpuId` are **never** sent: the server strips and
re-derives them at finalize (§11.6).

### Why `ramRatedSpeedMtps` is often absent

`Win32_PhysicalMemory.Speed` is documented as the module's maximum capable
speed, but BIOSes disagree about what they put there. Two patterns were
observed while building this:

- `Speed` 6000 / `ConfiguredClockSpeed` 4800 — the XMP/EXPO rating with the
  profile switched off. This is what the ram-below-rated rule (§15.3) wants.
- `Speed` 4800 / `ConfiguredClockSpeed` 6000 — verified on a Ryzen 9800X3D with
  EXPO **enabled**. Here `Speed` is the JEDEC base: a floor, not a rating.

The real XMP/EXPO profile lives in the SPD EEPROM behind SMBus and is not
reachable from a user-mode process. So `Speed` is declared as the rated speed
only when it exceeds the running speed — the one case where it demonstrably
describes a capability above what is configured. Otherwise the field is omitted
and the diagnostic self-suppresses, exactly as it does for a browser upload.
Declaring the JEDEC base as a "rating" would reassure users on a number the
client cannot know.

---

## Signing: three keys, three jobs

These are **not** interchangeable and must never be reused across roles.

| # | Key | Protects | Where it lives |
|---|---|---|---|
| 1 | **Ed25519 payload key** (§22.3) | Tamper-evidence on the uploaded frame Parquet | `HEIMDALL_SIGNING_PRIVATE_KEY` at build time; public half in the server's `HEIMDALL_SIGNING_PUBLIC_KEY` |
| 2 | **Tauri updater keypair** | The update manifest — stops a malicious update installing | `TAURI_SIGNING_PRIVATE_KEY` (+ password) in CI; public key in `tauri.release.conf.json` |
| 3 | **Authenticode certificate** | The installer — stops SmartScreen warning users off | Azure Trusted Signing; CI holds only Azure credentials |

### 1. Ed25519 payload key

```bash
pnpm --filter @heimdall/desktop exec node scripts/generate-signing-key.mjs   --out ~/heimdall-signing-key.txt
```

Node's crypto rather than `openssl`, so it works on a stock Windows box. It
writes the private half to the given file (never to the terminal) and prints the
public half, already in the base64 SPKI DER the server wants; it refuses to write
inside the working tree. A Rust test pins the interop — the exact PKCS#8 shape
Node emits is asserted to load in `ed25519-dalek` — so a key this script mints
cannot fail at release time.

Then: private half → the `HEIMDALL_SIGNING_PRIVATE_KEY` repository secret;
public half → `HEIMDALL_SIGNING_PUBLIC_KEY` on the server; delete the file.

A build can also print its own public half: the `signing_public_key` command
returns exactly the base64 the server expects.

Losing the private key is recoverable — generate a new pair and update both
sides. Runs signed with the old key then record `signature_valid: false`, which
is evidence only and never affects acceptance (§0.5).

**The key ships inside a downloadable binary and is extractable.** That is a
recorded trade-off, not an oversight. `signature_valid` means "produced by
something that looks like an unmodified client" and nothing stronger. It is
recorded as evidence and **never** gates acceptance (§0.5) — the server's
recompute from the stored Parquet is what decides whether a run is honest
(§11.5). See [`integrity-and-privacy.md`](integrity-and-privacy.md).

The signature covers the **frame Parquet only**. The declared hardware and
methodology in `POST /api/runs` are not signed, and the UI says so.

`HEIMDALL_SIGNING_PUBLIC_KEY` is publishable — publishing it is what lets
anyone verify a run's signature independently.

### 2. Tauri updater keypair

```bash
pnpm --filter @heimdall/desktop exec tauri signer generate -w updater.key
```

Public key → `plugins.updater.pubkey` in `src-tauri/tauri.release.conf.json`.
Private key + password → the CI secrets above. Keep the private key out of the
repository; losing it means no shipped client can ever be updated again.

### 3. Authenticode

Azure Trusted Signing (~$10/month) is the recommendation: a cloud HSM, works
headlessly in CI, and needs no physical EV token. The bundler invokes it via
`bundle.windows.signCommand` in the release overlay config. **This must be
acquired out of band** — until it is, installers are unsigned and Windows will
warn on first run.

---

## Build and release

```bash
pnpm install
pnpm --filter @heimdall/ui build
pnpm --filter @heimdall/desktop vendor   # vendors the fonts + PresentMon sidecar
pnpm --filter @heimdall/desktop dev     # tauri dev
pnpm --filter @heimdall/desktop build   # unsigned, non-updating local bundle
```

A local build needs **no secrets at all**: with no `HEIMDALL_SIGNING_PRIVATE_KEY`
the client uploads unsigned and the server records `signature_valid: null`,
which is a valid outcome.

`HEIMDALL_API_BASE_URL` defaults to `http://localhost:3000`. It is baked in at
build time so a shipped client cannot be redirected by editing a config file.

Releasing: push a `desktop-v*` tag. `.github/workflows/release.yml` builds,
signs with all three keys, and publishes the installer plus `latest.json` to a
GitHub release.

> **Rate limits:** the server keys uploads on client IP, and `clientIp()`
> returns `"unknown"` unless `RATE_LIMIT_TRUSTED_PROXY` is set. Behind
> Cloudflare in production it is — on a misconfigured origin every desktop user
> lands in one bucket and throttles each other.

---

## Claim handoff (§22.5)

After a successful upload the client opens
`/runs/<id>?claim=<plaintext management token>` in the default browser. If the
visitor is signed in, the run page offers "Claim this run", which calls the
existing `POST /api/runs/:id/claim`. Single-use, atomic, no new auth surface.

The desktop client cannot create a **private** run: that needs a signed-in
owner at create time, which the handoff has no way to provide. Runs are created
public or unlisted, and the owner flips visibility from `/account` after
claiming. The UI states this rather than offering a control that would fail.

The plaintext token is dropped from the address bar once the claim succeeds.

---

## Crash reporting

Opt-in by construction, with no SDK. A Rust panic hook writes one plain-text log
to the app's local data directory (`last-crash.log`). On the next launch the UI
offers "Send crash report", which opens a **pre-filled GitHub issue** in the
browser — the user reads it and presses submit, or dismisses it. Nothing leaves
the machine unless a human sends it.

The log contains the app version, the OS name, the panic message and the source
location. No capture data, no hardware snapshot, no file paths beyond the Rust
source location.

An aggregating service (Sentry) is the alternative if per-crash telemetry is
ever wanted. It is a separate decision with real privacy weight, so it is not
the default.

---

## Testing

```bash
cargo test  --manifest-path apps/desktop/src-tauri/Cargo.toml
cargo clippy --manifest-path apps/desktop/src-tauri/Cargo.toml --all-targets --all-features --locked -- -D warnings -D clippy::perf
pnpm --filter @heimdall/desktop test        # must pass on Linux — no Tauri runtime
```

The Rust suite covers what can be decided without a GPU: sidecar argv and CSV
stream framing, driver-version normalization, the WMI row → `HardwareSnapshot`
mapping, HAGS tri-state, Ed25519 sign → verify against the exact SPKI base64 the
server parses, and payload custody. The Windows syscalls themselves are
deliberately a thin wrapper around those pure functions.

The JS suite covers the capture state machine, the live frame-time readout, the
transport adapter (against a mocked `invoke`), declared-methodology
completeness, and all four kit screens.
