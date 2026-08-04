# Parser fixtures

Golden files for `@heimdall/parsers`. Most are small (10–20 rows), hand-checkable
synthetic captures; the rows marked **anonymized real capture** pin observed tool
output after machine-identifying fields are removed. Every parseable fixture has a
colocated `*.expected.json` (`{summary, sampleCount, firstFrame, lastFrame,
hardware?}`) whose numbers were computed by hand — see the frame-time design
notes below.

## Provenance

| Fixture | Source | Provenance | Notes |
|---|---|---|---|
| `capframex/csv/nvidia-full-sensors.csv` | CapFrameX CSV | synthetic | full sensor set incl. `MsGPUActive` |
| `capframex/csv/amd-decimal-comma.csv` | CapFrameX CSV | synthetic | German locale: `;` delimiter, decimal comma |
| `capframex/csv/intel-missing-sensors.csv` | CapFrameX CSV | synthetic | frame times only → `missing-sensors` warning |
| `capframex/csv/columns-reordered.csv` | CapFrameX CSV | synthetic | same data as nvidia, shuffled column order |
| `capframex/json/nvidia-capture.json` | CapFrameX capture JSON | synthetic | `Info` block → `HardwareSnapshot` |
| `capframex/json/amd-sensordata2-real.json` | CapFrameX 1.8.6.2 capture JSON | anonymized real capture | AMD `SensorData2` periodic channels + frame-aligned `CpuActive`/`GpuActive`; source Info reported 26.3.1 while the OS driver store was AMD 26.6.1 (`32.0.31019.2002`) |
| `presentmon/v1-basic.csv` | PresentMon 1.x | synthetic | `MsBetweenPresents`/`TimeInSeconds`, no sensors |
| `presentmon/v2-basic.csv` | PresentMon 2.x | synthetic | `FrameTime` + `CPUBusy`/`GPUBusy`; `CPUStartTime` offset from 0 |
| `presentmon/v2-gpu-telemetry.csv` | PresentMon 2.x | synthetic | opt-in `GPUUtilization/GPUFrequency/GPUPower/GPUMemUsed` |
| `presentmon/v2-amd-real.csv` | PresentMon 2.4.1 | anonymized real capture | AMD v2 output; proves `CPUStartTime` is milliseconds and busy fields are frame-aligned |
| `presentmon/v2-v1-metrics-amd-real.csv` | PresentMon 2.4.1 `--v1_metrics` | anonymized real capture | compatibility profile with `msGPUActive` and presentation semantics |
| `mangohud/nvidia-basic.csv` | MangoHud | synthetic | sysinfo block + `elapsed` ns timestamps |
| `mangohud/amd-mesa-basic.csv` | MangoHud | synthetic | same frame shape as `nvidia-basic`, with a Mesa `driver` sysinfo value — pins that the Linux driver-currency contract reads `Mesa <version>` verbatim (`docs/driver-currency-curation.md`) |
| `malformed/*` | — | synthetic | each maps to one typed `ParseErrorCode` |

## Frame-time design (how the expected numbers were computed)

- **CapFrameX set** — 20 frames: 16×8 ms, 3×12 ms, 1×50 ms (sum 214 ms).
  avg = 20000/214 ≈ 93.458 FPS; 1%/0.1% low = slowest 1 frame = 50 ms = 20 FPS;
  p50/p95/p99 (nearest-rank) = 8/12/50 ms; stutter: median 8 ms → bound
  max(2.5×8, 20) = 20 ms → only the 50 ms frame → 1.
- **PresentMon + MangoHud sets** — 10 frames: 9×10 ms, 1×30 ms (sum 120 ms).
  avg = 10000/120 ≈ 83.333 FPS; lows = 30 ms = 33.333 FPS; p50/p95/p99 =
  10/30/30 ms; stutter: median 10 ms → bound 25 ms → the 30 ms frame → 1.

## Real-export wanted-list (flips sensor-matrix cells to `verified-real`)

The `SENSOR_AVAILABILITY` matrix (`src/sensor-availability.ts`) is seeded from
documented behavior. AMD CapFrameX and PresentMon cells now have real provenance;
the remaining cells stay `synthetic`. Landing a real
export here **and flipping its cell to `verified-real` in the same PR**
completes the §7.3 spike for that cell. Wanted, in priority order:

1. **CapFrameX CSV — NVIDIA** (launch wedge): confirm sensor column names
   (`GpuUsage`, `GpuClock`, `GpuPower`, `GpuMemUsage`, `CpuUsage`,
   `MsGPUActive`) and units.
2. **CapFrameX CSV — AMD**: confirm board-power availability (`gpuPowerW` is
   seeded `sometimes`).
3. **CapFrameX CSV — Intel Arc**: confirm clock/power coverage.
4. **CapFrameX capture JSON** (NVIDIA / Intel remaining): AMD 1.8.6.2 now confirms
   `Info`, periodic `SensorData2`, and frame-aligned `CpuActive`/`GpuActive`.
5. **CapFrameX CSV — German locale**: confirm `;` + decimal-comma export shape.
6. **PresentMon 2.x GPU telemetry** (`GPUUtilization`/`GPUFrequency`/`GPUPower`/
   `GPUMemUsed`) — **not obtainable from any PresentMon console CLI.** Tested on
   Windows 11 / RX 9070 XT three ways: bundled 2.4.1 alone, 2.4.1 with Intel's
   full MSI installed and `PresentMonSharedService` running, and Intel's own
   2.5.1 console CLI with the service running. Identical header every time, and
   2.5.1's `--help` offers no telemetry switch, and Intel's own console-app
   README documents only timing GPU metrics (`MsGPULatency`/`MsGPUTime`/
   `MsGPUBusy`/`MsGPUWait`/`VideoBusy`). The columns belong to the PresentMon
   *UI application*, not the console tool. `v2-gpu-telemetry.csv`
   stays synthetic; a contributor would need an export from the UI app, whose
   CSV shape is unverified here. The AMD cell's
   millisecond `CPUStartTime` and frame-aligned `CPUBusy`/`GPUBusy` are already
   confirmed; the NVIDIA/Intel cells still need real exports.
7. **PresentMon 1.x** (any vendor): confirm header shape.
8. **MangoHud** (NVIDIA / AMD / Intel): confirm `gpu_vram_used` unit (we
   assume GiB → ×1024 to MB), `ram` sysinfo unit (we assume MB above 256), and
   whether GPU strings can contain commas.
   Phase 9.5 shipped the Linux capture client, so producing one of these is now
   a matter of arming Heimdall and pressing MangoHud's log hotkey — on hardware
   you own. **All three cells are still `synthetic`:** no real MangoHud export
   has been landed, so the two unit assumptions above remain assumptions and are
   still marked as such in `mangohud.ts`. Do not flip a cell on the strength of
   the parser agreeing with itself; the flip needs the file.
9. **Any file with a frame-generation column** (DLSS3/FSR3/AFMF capture) —
   **still open, and harder than it looks.** `--track_frame_type` emits a
   `FrameType` column, but its help states it "requires application and/or
   driver instrumentation using Intel-PresentMon provider". AMD's driver does
   not emit that provider: an RX 9070 XT running Cyberpunk 2077 with FSR AND
   frame generation enabled produced 14,241 rows, every one `Application`.
   A useful capture therefore needs a title or driver that instruments for
   Intel's provider — realistically an Intel XeSS-FG title, or a game shipping
   the PresentMon SDK.

   **What a real capture would unblock has changed twice since this item was
   written, so do not read the old summary here.** It used to say
   `generatedFramePct` is always 0 and `generatedFrameTech` always resolves to
   `none`; both halves are now wrong:

   - §22.11 (`presentmon@1.2.0`) stopped the pipeline manufacturing
     `generatedFrameTech: none`. A declared tech is kept as declared, and an
     undeclared run carries `unknown` — only an *observed* generated frame lets
     the recompute overrule a declaration.
   - §22.12 (Phase 9.6) added the rendered-only rate, which is computed from
     exactly this column. Synthetic fixtures cover the arithmetic
     (`frame-generation.test.ts`, and the golden pair below), but nothing here
     has ever seen a real interpolated present.

   So a real capture now flips a sensor cell *and* gives the rendered-rate
   coalescer its first non-synthetic input. See
   [`docs/frame-generation.md`](../../../docs/frame-generation.md) for what the
   pipeline can and cannot see, and for the measured RX 9070 XT numbers.

### NVIDIA and Intel cells are open contributions

Phase 9 shipped the desktop capture client, which makes producing a real
PresentMon export a matter of pressing a hotkey — but only on the hardware you
own. The project's own sweep was therefore **AMD only**, and the
`presentmon.nvidia` / `presentmon.intel` cells (and the corresponding CapFrameX
and MangoHud cells) remain `synthetic` by choice, not by oversight.

This is a documented gap rather than a silent one: a `synthetic` cell means "we
seeded this from vendor documentation and have never held the file in our
hands", and every surface that reads the matrix says so. Nothing in the product
claims otherwise.

**If you have an NVIDIA or Intel GPU, this is the single highest-value thing you
can contribute.** Capture a run with Heimdall Capture (or PresentMon directly),
then follow the procedure below — it is deliberately short, and the
flip-honesty test will tell you immediately if the evidence and the claim
disagree.

### Provenance-flip procedure (canonical — 16a.1)

Flipping a `SENSOR_AVAILABILITY` cell from `synthetic` to `verified-real` is a
single, self-contained PR that lands the export and its proof together. The
flip-honesty test (`sensor-availability.test.ts`) **fails** if a cell claims
`verified-real` without a matching golden fixture on disk, so these steps are
not optional bookkeeping — they are enforced.

1. **Anonymize.** The `Application`/process columns and hardware strings are the
   only identifying fields; scrub anything else machine-specific.
2. **Drop the fixture.** Put the file under its source directory and add a
   colocated `*.expected.json` (run the parser + `computeRunSummary`, then
   **verify the numbers by hand** before committing them as golden).
   `golden.test.ts` picks it up automatically — a parseable fixture without an
   expected file fails the suite.
3. **Flip the cell.** Replace the cell's `cell(...)` with `verifiedCell(...)`,
   passing a `SensorMatrixCellEvidence` that records the real export's `source`,
   `gpuVendor`, `driver`, `toolVersion`, verbatim `headers`, per-field `units`
   and `frameAligned` flags, and the repo-relative `fixture` path from step 2.
4. **Update the provenance table** above so the human-readable matrix matches.

The launch-wedge priority is the **CapFrameX CSV — NVIDIA** cell (item 1 of the
wanted-list); PresentMon and MangoHud get their live-client confirmation in
Phase 9 §22.
