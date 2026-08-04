# Frame generation: what Heimdall can and cannot see

Phase 9.6 (§22.12–§22.13). This document covers two things: how the rendered-only rate is computed
and why the obvious implementation is wrong, and what the frame-generation "physics signature" looks
like on the one machine we have measured it on — along with why no rule fires on it.

> **The headline caveat, stated once and repeated where it matters:** every measured number in this
> document comes from **one GPU, one title, one resolution**. It is n = 1. Nothing here is
> calibrated, and nothing here annotates a run.

---

## 1. The problem

A generated frame is not a rendered frame. When frame generation is on, the presented frame stream
contains interpolated frames that no game logic produced, so a run's `avgFps`, 1% lows and stutter
count all describe something other than what they claim.

Measured on an RX 9070 XT, Cyberpunk 2077, 2560x1440:

| | Frame generation ON | Frame generation OFF |
| --- | --- | --- |
| Reported avg FPS | 243.9 | 130.7 |
| Presents captured | 14,241 | — |
| Mean present interval | 4.10 ms | 7.65 ms |
| Minimum present interval | **0.32 ms** | **3.11 ms** |

Phase 9 (§22.11) fixed a narrower problem: the pipeline used to *manufacture* the claim that such a
run was not frame-generated. It no longer does. But 243.9 was still the only number on the page.

## 2. What the pipeline can see

Frame type reaches Heimdall through exactly one path: **PresentMon v2 with `--track_frame_type`**,
which emits a `FrameType` column.

That column is only populated where something instrumented Intel's provider. PresentMon's own help
states it "requires application and/or driver instrumentation using Intel-PresentMon provider".
**AMD's driver does not emit that provider.** The RX 9070 XT capture above, with FSR *and* frame
generation enabled, produced 14,241 rows — every single one labelled `Application`.

Three consequences follow, and they are load-bearing:

1. **An all-`Application` column is indistinguishable from no column at all.** Column *presence*
   proves nothing. Only an observed `true` carries information — which is why
   `reconcileGeneratedFrameTech` keys on generated frames having been *seen*, never on the column
   existing (§22.11).
2. **A rendered rate cannot be computed for AMD frame generation at all.** The run report says so in
   those words rather than omitting the control silently.
3. **The frame-type column is read only on the v2 profile.** v1 and the v1-metrics-compat profile
   carry *backward*-looking intervals, so a frame type read there would be paired with the interval
   on the wrong side of it. `parsePresentMon` gates the lookup on `isV2` (`presentmon@1.3.0`).

Neither `generatedFramePct` nor the physics statistics below can distinguish a run whose uploader
declared `none` while frame generation was on from an honest one. That gap is real and is not closed
by this phase.

## 3. The rendered rate

### 3.1 Why filtering is wrong

The intuitive implementation — drop the rows where `generated === true`, summarize what's left — is
wrong, and it fails *quietly*.

`frameTimeMs` is an **interval**, not a timestamp. Dropping a row drops its duration too. In the
limiting case where every present has the same duration `d`, filtering `k` of `n` rows gives

```
1000·k / (k·d)  =  1000/d       and       1000·n / (n·d)  =  1000/d
```

— the identical rate. On the measured capture that is exactly what happens: 7,120 rendered rows over
their own 4.10 ms mean interval recompute to `1000 × 7120 / (7120 × 4.10)` = **243.9 FPS**,
bit-for-bit the presented number. A reviewer glancing at the output sees a plausible number and no
error.

When durations differ, filtering is wrong in a *third* direction: it lands on neither rate. On a
stream of 8 ms rendered and 0.4 ms generated presents it reports 125 FPS, against 238.1 presented and
119.0 genuinely rendered. Both cases are pinned in `frame-generation.test.ts`.

### 3.2 The definition

> The rendered series is the set of intervals **between consecutive rendered presents**. A generated
> present's time is absorbed into the interval that contains it.

An accumulator **starts at** a rendered present and closes when it **reaches** the next one
(exclusive). `n` rendered presents therefore bound `n − 1` intervals.

The forward convention is not a stylistic choice. Verified on `fixtures/presentmon/v2-amd-real.csv`:

```
10058.6817 + 8.6357 = 10067.3174      ← exactly the next row's CPUStartTime
```

on four consecutive rows of real hardware. So `d[i] = t[i+1] − t[i]`. The backward reading is off by
one row per boundary — harmless on a strictly alternating stream, but it moves p95/p99, the lows and
the stutter count on any irregular one. (That the two PresentMon profiles genuinely disagree is
visible in `v2-v1-metrics-amd-real.csv`, where `2.01124880 − 2.00495280 = 6.296 ms` is row **2**'s
`msBetweenPresents`, not row 1's.)

Unlabelled presents inside an evidence-bearing run are **absorbed**, not treated as rendered: the
time elapsed, we just don't know what bounded it.

### 3.3 Does it measure what it claims?

This is the only evidence that it does, and it is worth stating precisely.

```
7,120 rendered presents  →  7,119 intervals over ~58.4 s  →  121.9 rendered FPS
measured with frame generation OFF                        →  130.7 FPS
                                                    residual  −6.7%
```

A −6.7% residual is what we should expect: running frame generation consumes base render budget, so
the rendered rate under FG should sit slightly *below* the same scene's native rate. The sign and the
magnitude are both plausible. This is agreement, not proof — one machine, one title.

### 3.4 What is stored, and where

`computeRenderedFrameAnalysis` feeds the coalesced intervals into the **existing**
`computeRunSummaryFromFrameTimes`. No percentile, low or stutter definition is rederived, which is
what makes server/browser agreement structural rather than merely tested.

The result is a discriminated union on `state`, stored in `runs.rendered_frame_analysis`:

| `state` | Meaning |
| --- | --- |
| `available` | carries the rendered summary and the three present-type counts |
| `no-frame-type-evidence` | no present was ever labelled generated |
| `no-generated-frames` | the capture reports frame type and shows none generated |
| `too-few-rendered-presents` | fewer than `MIN_RENDERED_INTERVALS` (10) intervals |

`no-generated-frames` deliberately produces **no** rendered summary. Not because it would duplicate
the presented one, but because it would *not*: the coalescer returns `d[0..n−2]`, differing in the
3rd–4th significant figure. Two numbers claiming to be the same rate and disagreeing slightly is
worse than one number.

### 3.5 What the toggle does and does not change

The run report offers **Presented** / **Rendered**. It switches the stat tiles, the smoothness bars
and the frame-time chart together — a trace drawn over presented frames underneath rendered numbers
contradicts itself, and the rendered stream has its own median, so it has its own stutter threshold.

Deliberate exclusions:

- **The busy-time overlay is forced off in rendered mode.** `cpuBusyMs`/`gpuBusyMs` are per-present
  and do not survive coalescing; drawing them against rendered intervals would be a fabricated trace.
- **The "Generated frames %" tile is replaced, not repointed.** Fed a rendered summary it reads 0%
  for a run that is half generated — re-manufacturing the exact false claim §22.11 removed. It
  becomes an "Interpolated presents" count.
- **The share card keeps the presented FPS.** `generateMetadata` runs server-side with no toggle
  state, and the presented rate is the canonical stored summary. A share card that disagreed with the
  page's default view would be worse than one that matches it.
- **Comparability and pooling are untouched.** `frameGeneration` is already a comparability key, so
  declared-FG and declared-non-FG runs are in different buckets regardless. This is presentation.
- **`RunSummary`, `summaryMismatch` and the client upload contract are unchanged.** The §11.5
  recompute gate did not move to accommodate this phase, and the rendered analysis never influences
  the validated/flagged verdict.

## 4. The physics signature (§22.13) — characterisation only

**No rule ships. No run is annotated. Nothing reaches the wire.**

### 4.1 The signal

Sub-millisecond presents. A 0.32 ms present is not a plausible rendered frame at 1440p.
`MIN_FRAME_TIME_MS` is 0.01, so these presents survive parsing and the signal reaches storage intact.

`runs.present_time_profile` stores, per run: `minFrameTimeMs`, the low-tail nearest-rank percentiles
(`p0_1` / `p1` / `p5`), `subMillisecondPresentCount` / `Fraction`,
`adjacentSubMillisecondPairFraction`, and `medianOverMinRatio`.

`medianOverMinRatio` is the one to lead with, because it is **scale-free** — independent of base
framerate, resolution and title, which answers the obvious objection that the FG multiplier drifts
(DLSS4 multi-frame generation is 3–4×, not 2×, and the multiplier moves with base framerate). On the
measured pair it separates by 5×:

| | median ÷ min | |
| --- | --- | --- |
| Frame generation ON | 4.10 / 0.32 | **12.8** |
| Frame generation OFF | 7.65 / 3.11 | **2.46** |

**On n = 1 this is worth nothing.** It is one GPU, one title, one resolution.

### 4.2 Why within-run rather than ratio-vs-aggregate

Comparing a run's FPS to its cohort's average was considered and rejected:

- the aggregate baseline is **already contaminated** by the undeclared runs it is meant to find;
- it is inert below the §17.4/§18.2 cold-start threshold (30 runs per game + canonical GPU), so it
  would do nothing at current data volume;
- 2× is not a clean constant, and comparability keys control resolution/preset/upscaler/scene but not
  settings *within* a preset — and a CPU-bound section moves FPS more than frame generation does.

### 4.3 Why no rule fires

§0.5: **evidence, never an accusation.** Telling an honest uploader their run looks like cheating is
a worse failure than missing a dishonest one, and a false positive is unfalsifiable from the
uploader's side — there is no artefact they can produce to prove a negative.

A threshold fitted to one GPU, one title and one resolution cannot carry that weight.

### 4.4 Known false-positive shapes

Any future rule must survive these, all of which produce sub-millisecond or wildly irregular presents
without any frame generation:

- **menus and loading screens** — trivially cheap frames at hundreds of FPS;
- **capped or idle sections** — a frame limiter or an alt-tabbed window;
- **very low resolutions or minimum settings** on high-end hardware;
- **capture start/stop boundaries**, where the first or last interval is an artefact.

### 4.5 What calibration would require

At minimum: captures from **more than one vendor** with frame type genuinely labelled (realistically
an Intel XeSS-FG title or a game shipping the PresentMon SDK — see wanted-list item 9 in
[`../packages/parsers/fixtures/README.md`](../packages/parsers/fixtures/README.md)), each with a
matched frame-generation-off control on the same hardware, scene and settings; plus deliberate
negative samples covering §4.4. Until then the statistics accumulate and no threshold is chosen.

## 5. Fixtures

No real frame-generated capture is obtainable on the hardware available to the project (§22.6), so
the arithmetic is pinned by synthetic fixtures built under the `fixtures/README.md` 16a.1 procedure:

- `presentmon/v2-frame-generation.csv` — 12 alternating `Application` (8 ms) / `Intel_XEFG` (0.4 ms)
  pairs. Presented `1000 × 24 / 100.8` = **238.095 FPS**; rendered `1000 × 11 / 92.4` = **119.048
  FPS**. Both hand-computed, both in the colocated `.expected.json`.
- `frame-generation.test.ts` — the forward convention, the `renderedCount − 1` invariant, the
  leading/trailing accounting, absorbed unlabelled presents, all four states, and a fast-check
  property proving an all-rendered stream yields `d[0..n−2]` rather than the presented summary.

Nothing in this repository has ever seen a real interpolated present.
