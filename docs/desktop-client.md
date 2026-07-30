# Heimdall Capture — desktop client

The capture client (`apps/desktop`, Phases 9 and 9.5, §21–§24). Get frame-time
data from a game, get a shareable run report. It is a Tauri 2 shell: Rust owns
the capture backend, the hardware reads and the signing key; the webview does all
parsing and UI with the **same** `@heimdall/parsers` and `@heimdall/ingest-client`
code the web hub runs.

There are **two capture backends**, selected by `#[cfg]`, behind one session
contract (`src-tauri/src/capture.rs`):

| | Windows (§21–§22) | Linux (§23–§24) |
|---|---|---|
| Row source | bundled Intel PresentMon sidecar, spawned by us | the user's own MangoHud, watched for a log |
| Trigger | Heimdall's hotkey starts the capture | Heimdall arms; **MangoHud's** hotkey starts the log |
| Overlay injected | none (PresentMon uses ETW) | none — see below |
| GPU telemetry | Heimdall samples PDH counters (§22.2) | MangoHud logs its own |
| `captureTool` | the pinned PresentMon version | whatever `mangohud --version` reports |

Everything after the bytes — parse, metrics, sign, upload, claim — is byte-for-byte
the same code on both.

---

## Linux and SteamOS (§23–§24)

### Why Heimdall watches instead of launching

Heimdall injects no overlay on Linux and does not wrap the game's command line.
MangoHud is the user's: they installed it, they configured it, and they start and
stop its logging with its own hotkey (Shift+F2 by default). Heimdall **arms a
watcher** and picks up the log that appears.

That is a product decision, not a workaround. A second overlay injected into a
game the user already has MangoHud in would be worse for them and less honest
about provenance — the run would say it was captured by a tool that was not the
one in the frame path.

It has one consequence worth stating plainly: **the client cannot promise a
capture will start.** It arms, and it reports what appears. That is why the state
machine has an `armed` screen that Windows never enters, and why
`start_capture` returns a tagged `CaptureStart` (`started` or `armed`) rather
than assuming rows are already flowing.

### Setup

MangoHud has to be told to write logs somewhere Heimdall can find them. The
onboarding screen runs four checks and prints the exact lines to add — it never
writes the file, because Heimdall does not own `MangoHud.conf`.

```ini
# ~/.config/MangoHud/MangoHud.conf
output_folder=/home/you/mangohud-logs
log_interval=100
gpu_stats
cpu_stats
vram
```

| Check | Blocking | Why |
|---|---|---|
| `mangohud-installed` | yes | `mangohud --version` has to answer; we bundle nothing |
| `output-folder` | yes | without it MangoHud writes beside each game's working directory, which the client cannot know |
| `sensor-params` | no | fewer sensors means fewer diagnostics, and every sensor rule self-suppresses on missing data — skip, never fail |
| `log-interval` | no | only affects whether a **live** trace can be drawn; the capture is complete either way |

Two config locations are read, and the second is the one people miss:

1. `MANGOHUD_CONFIG` (inline) layered over the file, per-parameter
2. `$MANGOHUD_CONFIGFILE`, else `$XDG_CONFIG_HOME/MangoHud/MangoHud.conf`, else
   `~/.config/MangoHud/MangoHud.conf`
3. `~/.var/app/com.valvesoftware.Steam/config/MangoHud/MangoHud.conf` — **Flatpak
   Steam**. A game launched from Flatpak Steam reads *this* file, not the host
   one, so a perfect `~/.config` setup can still produce nothing
4. `/etc/MangoHud.conf`

Every resolved `output_folder` is watched, not just the first: a machine with both
a host Steam and a Flatpak Steam has two configs that can name two folders, and
the watcher cannot know which the next game will read.

**What the client cannot see.** MangoHud is very often configured per-game
through a Steam launch option (`MANGOHUD_CONFIG=... %command%`). That environment
belongs to the game process, not to us. A host config is evidence about the
default and nothing more, and every config-derived check says so rather than
asserting the user got it wrong.

### How the watcher picks a log

- A 500 ms directory scan while armed. Polling, not inotify: no new crate, no
  per-user watch limits, no Flatpak portal complications, and the cost only
  exists between arm and stop.
- The capture is the **newest `*.csv` modified at or after the arm instant whose
  head matches MangoHud's `fps,frametime` header shape**. Both halves matter. A
  user who has been benchmarking all week has a folder full of valid logs, and
  picking the wrong one would produce a run that is entirely real and entirely
  not what they just captured.
- Tail reads go through the same `CaptureBuffer` (`src-tauri/src/stream.rs`) as
  PresentMon's stdout, so line framing, CRLF handling, the trailing-partial-row
  rule and the 64 MiB cap are one implementation rather than two.
- A log size that holds steady for 2.5 s ends the capture — but only once at
  least one frame has been read. Without that guard, a MangoHud that creates the
  file and writes nothing until logging stops would have its capture ended 2.5
  seconds in with zero frames.
- Pressing Stop before any log appears is `no-capture-log`, whose message names
  MangoHud's hotkey. "0 frames captured" reads as a Heimdall bug when it is not
  one.

### The live-trace honesty case

MangoHud writes in bursts. With `log_interval` set the file grows during the
capture and the sparkline updates; without it the rows can arrive all at once at
the end. Both produce a complete, uploadable capture — only the live chart
differs.

So the Capturing screen says **"MangoHud is logging — the trace appears when it
flushes"** instead of rendering an empty chart that looks broken. Same rule the
diagnostics follow: skip, never fail.

Related, and a real bug this phase fixed: the live readout used to treat the
first row it saw as the header. A MangoHud log's first row is a sysinfo key row,
so the readout found no frame-time column and silently blanked the chart for
every Linux capture. It now scans a bounded preamble
(`apps/desktop/src/lib/live-frames.ts`).

### Hardware: MangoHud first, sysfs for the gaps (§23.2)

On Linux the **MangoHud log's own sysinfo row is the preferred source.** It was
written by the tool that was inside the game, and its `driver` field carries the
Mesa version string that `docs/driver-currency-curation.md` locks as the Linux
driver-currency contract.

`src-tauri/src/linux.rs` fills only what MangoHud omits, and
`apps/desktop/src/lib/hardware.ts` drops any field the capture already supplied
before it reaches `uploadCaptureBytes` — whose merge otherwise layers the
client's values *over* the parser's. Without that, `/sys` would replace
`Mesa 26.1.4` with a kernel module name and every Linux driver-currency rule
would miss.

| Field | Source |
|---|---|
| `gpu`, `cpu`, `os`, `gpuDriver`, `ramGb` | MangoHud sysinfo row, when the log has one |
| `cpu` (fallback) | `/proc/cpuinfo` `model name` — searched to exhaustion before `model`, which on x86 is a numeric id and once reported a CPU called "68" |
| `ramGb` (fallback) | `/proc/meminfo` `MemTotal` |
| `os` (fallback) | `/etc/os-release` `PRETTY_NAME` + `/proc/sys/kernel/osrelease` |
| `gpuVendor` | `/sys/class/drm/card*/device/vendor` — PCI vendor ids are the same numbers DXGI reports, so `driver.rs`'s table is reused rather than duplicated |
| `gpuVramTotalMb` | `/sys/class/drm/card*/device/mem_info_vram_total`. The NVIDIA proprietary driver exposes nothing here, so the field is **omitted, not zero** — a VRAM total of 0 would make the saturation rule read every capture as over capacity |
| `resolution` | first mode of the first connected connector in `/sys/class/drm`. No X or Wayland dependency, which is the only way this works in gaming mode |
| `gpuDriver` (last resort) | the kernel module + release, e.g. `amdgpu (kernel 6.11.11-valve)` — deliberately unmistakable for a Mesa version |

**Deliberately absent.** These are the invariant working, not gaps to paper over:

- `ramSpeedMtps` / `ramRatedSpeedMtps` — the speeds live in DMI, and
  `/sys/firmware/dmi/tables` is root-only. A per-user client cannot read them, so
  the fields are omitted and the ram-below-rated rule (§15.3) self-suppresses. A
  fabricated rating would tell a user their RAM is fine on a number nobody
  measured.
- `hags` — a Windows scheduling concept. Reported as unknown, never `false`;
  methodology fields feed comparability, so declaring a setting that does not
  exist here would silently split runs.
- The GPU **name** is not read from sysfs at all. Naming a PCI device needs a
  hardware database we do not ship; `Unknown GPU` that MangoHud then replaces is
  honest where `amdgpu 0x7550` would not be.
- No anti-cheat notice. Heimdall does not inspect the game's process on Linux, so
  the field stays absent rather than reporting "none detected".

### Frame generation

MangoHud logs no frame-type column at all, so **every Linux capture carries no
frame-type evidence** and `frameGeneration` resolves to the user's declaration or
to `unknown` (§22.11) — never to `none` on the strength of silence. FSR3 and AFMF
are common on Linux, so the Run details field does real work here; it is labelled
"The capture cannot detect this" on both platforms, which on Linux is
unconditionally true.

### Packaging

AppImage and deb are built by Tauri (`tauri.linux.conf.json`); rpm is absent
because we have not tested one. `apps/desktop/flatpak/dev.heimdall.capture.yml`
is a separate manifest where the **sandbox grants are the substance**: read-only
access to both MangoHud config locations and to the log folder, never
`--filesystem=host`. A Flatpak install cannot run `mangohud --version` (no host
PATH), so it reports `MangoHud (version unknown)` — an admitted limitation of
that packaging, not a bug.

MangoHud is **not** a package dependency. Its absence is a setup check; a package
manager pulling an overlay onto someone's machine because they installed a
benchmark viewer would be the wrong behaviour.

See `apps/desktop/src-tauri/CONFIG.md` for why the Tauri config is split by
platform — it is what unblocked the Linux build at all.

### Not verified

Phase 9.5 was verified on **dual-boot desktop Linux (Ryzen 9800X3D / RX 9070 XT)**
only. These are untested and are stated as untested:

- **SteamOS gaming mode and the Steam Deck.** No Deck was available. The sysfs
  reads are chosen to work without a display server, and the watcher needs no
  window — but that is reasoning, not a result.
- **The Flatpak build's sandbox grants** against a real Deck install. The
  manifest has never been built or run.
- **NVIDIA and Intel MangoHud sensor cells.** They remain `synthetic` in
  `SENSOR_AVAILABILITY`, and the flip-honesty test enforces that. The
  `gpu_vram_used` (assumed GiB) and sysinfo `ram` (assumed MB above 256) unit
  assumptions are therefore still assumptions.

---

## Setup: Performance Log Users (Windows)

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
`generatedFrameTech: none`, because §11.5 derived it from the server's
recomputed `generatedFramePct`, which is 0 — and a declaration could not
override it, since a recomputed 0 was treated as decisive.

So a frame-generated run reports roughly double its real rendering rate, and its
1% lows and stutter counts are computed over interpolated frames.

**What was done about it.** The FPS figure cannot be corrected — the frames are
genuinely in the stream and nothing distinguishes them. What was fixed is the
false claim built on top:

- `reconcileGeneratedFrameTech` (now in `@heimdall/shared`, so the client at
  create and the verify worker at finalize apply one definition instead of two
  that had already drifted) only lets the recompute overrule a declaration in
  the direction the data supports. Generated frames SEEN → generation is a fact
  and the declaration may only name the tech. None seen → nothing is proven and
  the declaration stands, `unknown` included.
- Told nothing, a run records `unknown`. `none` is only ever recorded because a
  human declared it — the same trust `upscaler` and `settingsPreset` already
  get, and all three are comparability keys.
- The Run details form (and the web upload page) ask for frame generation, since
  the capture cannot show it.
- The parser records `generated: false` for an `Application` row, but that is a
  transcription of the cell and **not** evidence. Note the trap, because an
  earlier attempt at this fix fell into it: the client passes
  `--track_frame_type`, so an AMD capture HAS a `FrameType` column, and it is
  full of `Application`. Keying "did we look" on the column's presence therefore
  re-manufactured the same false `none` on the exact capture above. Only an
  observed `true` carries information.

That does not make a frame-generated run's FPS honest, but a declared
frame-generated run no longer goes out claiming it was not generated, and an
undeclared one says `unknown` rather than `none`. Making the FPS itself
meaningful under frame generation is still open.

What remains unsolved: an AMD run whose uploader declares nothing is `unknown`,
which is honest but still not the same bucket as a genuine non-generated run,
and one whose uploader declares `none` while frame generation is on is
indistinguishable from an honest one. Detecting that needs evidence we do not
have. Recorded rather than papered over; see IMPLEMENTATION_PLAN §22.11.

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

## What the client declares on Windows (§22.2)

The Linux equivalent is in the Linux section above; on that platform MangoHud's
sysinfo row outranks most of this table.

Everything here is **declared** by the client, never inferred from frames — the
parsers are explicit that tool version, HAGS and rated memory speed cannot come
out of a capture file. This is what unlocks diagnostics no browser upload can
reach.

| Field | Source |
|---|---|
| `gpu`, `gpuVendor`, `gpuVramTotalMb` | DXGI `IDXGIAdapter1::GetDesc1` — adapter matched to the captured pid's PDH LUID, then its monitor, with adapter 0 only as a last fallback; description, vendor id, exact `DedicatedVideoMemory` bytes |
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
pnpm --filter @heimdall/desktop vendor   # fonts, + the PresentMon sidecar on Windows
pnpm --filter @heimdall/desktop dev     # tauri dev
pnpm --filter @heimdall/desktop build   # unsigned, non-updating local bundle
```

`vendor` works on both platforms. Off Windows the sidecar fetch exits without
downloading — it is a Win32 executable that nothing on Linux reads — but it still
asserts its version pin agrees with `PRESENTMON_VERSION` first, because a drift
there would mislabel every Windows capture's provenance.

Linux needs the webview toolchain from the distro before `tauri build`:

```bash
sudo apt-get install --no-install-recommends -y \
  libwebkit2gtk-4.1-dev libgtk-3-dev libayatana-appindicator3-dev \
  librsvg2-dev patchelf
```

A local build needs **no secrets at all**: with no `HEIMDALL_SIGNING_PRIVATE_KEY`
the client uploads unsigned and the server records `signature_valid: null`,
which is a valid outcome.

`HEIMDALL_API_BASE_URL` defaults to `http://localhost:3000`. It is baked in at
build time so a shipped client cannot be redirected by editing a config file.
Local contributor builds use the development Tauri capability that admits that
origin. The release workflow replaces it with `release-capability.json` before
bundling; that production capability admits only `https://heimdall.dev` and
contains no localhost HTTP scope.
`HEIMDALL_R2_ACCOUNT_ID` and `HEIMDALL_R2_BUCKET` are baked in as the only
native upload destination. This is a second enforcement layer: even compromised
webview code cannot turn the privileged Rust PUT command into SSRF or send a
capture to another R2 account. Local R2 development must set the same two
variables before compiling the desktop client.

Releasing: push a `desktop-v*` tag. `.github/workflows/release.yml` builds with
the `release-updates` feature, checks the signed channel at startup, offers an
explicit verified install/restart, signs with all three keys, and publishes the
installer plus `latest.json` to a GitHub release. The Artifact Signing helper is
exact-pinned (`artifact-signing-cli 0.11.0`) so a new crates.io release cannot
silently gain access to the Azure credentials in the signing step.

> **Rate limits:** the server keys uploads on client IP, and `clientIp()`
> returns `"unknown"` unless `RATE_LIMIT_TRUSTED_PROXY` is set. Behind
> Cloudflare in production it is — on a misconfigured origin every desktop user
> lands in one bucket and throttles each other.

---

## Claim handoff (§22.5)

After a successful upload the client opens
`/runs/<id>#claim=<plaintext management token>` in the default browser. URL
fragments are not sent to the hub, reverse proxy, request logs, or Referer
headers. The web client moves the token into tab-scoped storage and scrubs the
address bar on its first render. If the
visitor is signed in, the run page offers "Claim this run", which calls the
existing `POST /api/runs/:id/claim`. Single-use, atomic, no new auth surface.
If finalization has an ambiguous response, or opening the default browser
fails, the desktop window retains the one-time credential and offers the same
claim handoff again. Capture, upload, and updater installation also share one
native activity gate, so installation cannot restart the process during an ETW
session or the create → PUT → finalize transaction.

The desktop client cannot create a **private** run: that needs a signed-in
owner at create time, which the handoff has no way to provide. Runs are created
public or unlisted, and the owner flips visibility from `/account` after
claiming. The UI states this rather than offering a control that would fail.

The plaintext token is dropped from the address bar before any claim attempt
and cleared from tab-scoped storage once the claim succeeds.

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

**Both platforms' rules run on both runners.** `mangohud.rs` and `linux.rs` are
pure by design — config parsing, the candidate-directory order including Flatpak
Steam, "newest log after arm" selection, stale-log and non-MangoHud rejection, the
quiesce rule, and the `/proc` and `/sys` mappers over fixture strings — so the
watcher's logic is covered on the Windows job too. `win.rs`, `presentmon.rs`,
`linux.rs` and `mangohud.rs` each keep a "not available" stub for the other
platform precisely so this works, which is why `lib.rs` carries a documented
`allow(dead_code)` on them.

What that does **not** cover is the platform halves themselves: `#[cfg]`-ed-out
code is never type-checked. Compiling the MangoHud watcher thread and the sysfs
reads at all is the `desktop-linux` CI job's real job.

The JS suite covers the capture state machine (including the `armed` transitions
and that Windows never enters them), the onboarding checks contract, the live
frame-time readout's MangoHud preamble handling, the hardware-merge precedence
rule, the transport adapter (against a mocked `invoke`), declared-methodology
completeness, and the kit screens.
