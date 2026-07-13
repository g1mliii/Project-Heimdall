# Parser fixtures

Golden files for `@heimdall/parsers`. Small (10–20 rows), hand-checkable, and
**synthetic**: authored from the documented CapFrameX / PresentMon / MangoHud
formats, not captured from real machines. Every parseable fixture has a
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
| `presentmon/v1-basic.csv` | PresentMon 1.x | synthetic | `MsBetweenPresents`/`TimeInSeconds`, no sensors |
| `presentmon/v2-basic.csv` | PresentMon 2.x | synthetic | `FrameTime` + `CPUBusy`/`GPUBusy`; `CPUStartTime` offset from 0 |
| `presentmon/v2-gpu-telemetry.csv` | PresentMon 2.x | synthetic | opt-in `GPUUtilization/GPUFrequency/GPUPower/GPUMemUsed` |
| `mangohud/nvidia-basic.csv` | MangoHud | synthetic | sysinfo block + `elapsed` ns timestamps |
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
documented behavior with every cell `provenance: "synthetic"`. Landing a real
export here **and flipping its cell to `verified-real` in the same PR**
completes the §7.3 spike for that cell. Wanted, in priority order:

1. **CapFrameX CSV — NVIDIA** (launch wedge): confirm sensor column names
   (`GpuUsage`, `GpuClock`, `GpuPower`, `GpuMemUsage`, `CpuUsage`,
   `MsGPUActive`) and units.
2. **CapFrameX CSV — AMD**: confirm board-power availability (`gpuPowerW` is
   seeded `sometimes`).
3. **CapFrameX CSV — Intel Arc**: confirm clock/power coverage.
4. **CapFrameX capture JSON** (any vendor): confirm `Info` key names and
   whether sensor arrays are frame-aligned or 250 ms-sampled.
5. **CapFrameX CSV — German locale**: confirm `;` + decimal-comma export shape.
6. **PresentMon 2.x with `--track_gpu`-style telemetry** (each vendor):
   confirm telemetry column names/units, `CPUStartTime` epoch.
7. **PresentMon 1.x** (any vendor): confirm header shape.
8. **MangoHud** (NVIDIA / AMD / Intel): confirm `gpu_vram_used` unit (we
   assume GiB → ×1024 to MB), `ram` sysinfo unit (we assume MB above 256), and
   whether GPU strings can contain commas.
9. **Any file with a frame-generation column** (DLSS3/FSR3 capture): no
   confirmed column name exists yet, so the `generated` flag is never set and
   `generatedFramePct` is always 0 — verifying this needs a real export.

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
