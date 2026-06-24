# Web Hub — UI kit

Recreation of Heimdall's centralized web dashboard: the surface where users upload
benchmark logs, view a shareable auto-diagnosing **Run Report**, browse aggregate
**Game** distributions, and run **Before/After** comparisons.

> Greenfield note: the production web app (`apps/web`) was empty scaffolding at the time
> this kit was built — these screens are derived from `PLAN.md` / `IMPLEMENTATION_PLAN.md`,
> not from existing UI code. Treat them as the proposed visual direction.

## Run it
Open `index.html`. It's an interactive click-through:
- **Run report** — the flagship shareable view: smoothness tiles (with 0.1%-low confidence label),
  frame-time chart with flagged stutters, auto-diagnostics (VRAM, RAM, CPU-bottleneck,
  driver-outdated), hardware snapshot.
- **Games** — aggregate distribution (bell curve + percentile), a benchmark-scene vs gameplay
  workload filter, a cold-start "insufficient data" state (< 30 runs → raw runs), submissions table.
- **Compare** — EXPO off→on before/after validator.
- **Upload log** — drag-to-parse ingest flow, plus a batch per-file progress list (partial failures).
- **Export video** — creator overlay export (transparent / green-screen / PNG-sequence, in-browser).
- **Account** — Clerk sign-in, per-run visibility controls, deletion/erasure, report/moderation.

## Files
| File | Purpose |
|---|---|
| `index.html` | App entry; wires routes + loads Babel/React/Lucide |
| `AppShell.jsx` | Sticky top bar + nav + `Icon` helper |
| `RunPage.jsx` | Flagship run report |
| `GamePage.jsx` | Aggregate game page (filters, distribution, table) |
| `extras.jsx` | `UploadPage` (+ batch) + `ComparePage` |
| `screens.jsx` | `AccountPage` (Phase 8) + `ExportPage` (Phase 11) |
| `charts.jsx` | Inline-SVG `FrameTimeChart`, `SmoothnessBars`, `BellCurve`, `DualFrameTimeChart`, `CompareBars` |

## Production note
This kit styles screens with the design system's `.hd-*` classes + tokens directly so it
renders without the compiled bundle. **In production, compose the real React components**
(`Button`, `Card`, `Stat`, `Diagnostic`, `Meter`, `Badge`, `Tabs`, …) from
`window.HeimdallDesignSystem_da7d5f` / the package export instead of re-applying classes.
The charts here are cosmetic SVG stand-ins for the production D3 views.
