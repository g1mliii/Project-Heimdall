# Heimdall Design System

The design language and component library for **Project Heimdall** — an open-source, hybrid
game-benchmarking platform that turns raw frame-time logs into accessible, shareable,
auto-diagnosing reports.

> **Greenfield project.** At the time this system was authored, the Heimdall repo was
> planning docs + empty app scaffolding (only `.gitkeep` files in `apps/web` and
> `apps/desktop`). Everything here is derived from the product's plans, not from existing UI.
> Treat it as the **proposed visual direction** — and tell us where it's wrong.

---

## Sources

This system was built from the attached **`Project Heimdall/`** codebase (read-only mount).
Key documents read:

- `README.md` — product pitch & architecture overview
- `PLAN.md` — master plan (product, data model, phases, risks)
- `IMPLEMENTATION_PLAN.md` — phased build plan, screens, tech stack
- `CLAUDE.md` / `AGENTS.md` — repo conventions
- `docs/integrity-and-privacy.md` — signing, diagnostics, fingerprinting stance

No Figma, brand kit, fonts, or existing components were provided. **No brand fonts or logo
existed** — both are proposed here (see Caveats).

---

## What Heimdall is

A user presses a hotkey in-game, plays ~60 seconds, presses it again, and gets a **shareable
link** to an interactive report: frame-time chart, smoothness tiers (Avg / 1% low / 0.1%
low), and **plain-English diagnostics** ("your RAM is below its rated speed — enable EXPO").
Users with existing CapFrameX/PresentMon/MangoHud logs can upload them with no account.

**Two products / surfaces:**
1. **Web Hub** (Next.js + D3) — upload, run report, aggregate game distributions, before/after
   compare, video overlay export. *Ships first; it's the wedge.*
2. **Desktop Capture Client** (Tauri 2 / Rust) — native hotkey capture, hardware snapshot,
   signed upload. *Phase 9+.*

Positioning: the gap nobody fills is **cross-platform capture + frictionless public
interactive sharing + automated diagnostics** in one tool.

---

## CONTENT FUNDAMENTALS

**Voice:** technical, candid, and confident — built by and for PC hardware enthusiasts. It
respects the reader's intelligence and never hypes. The plan literally includes an "honest
note on cryptographic signing" admitting what signing *can't* do — that intellectual honesty
is the brand's tone.

- **Person:** address the user as **you** ("where your run sits in the crowd"); the product
  is **we/Heimdall**. Plain imperatives for actions ("Upload a benchmark log", "Stop &
  analyze").
- **Casing:** **Sentence case** everywhere — headings, buttons, labels. Never Title Case UI.
  Acronyms keep their casing (FPS, GPU, VRAM, DX12, RT, EXPO, DLSS).
- **Numbers are the content.** Always concrete and unit-suffixed: `144.7 avg FPS`,
  `4800 / 6000 MHz`, `0.1% low`, `p99 14.1 ms`. Tabular mono everywhere numbers appear.
- **Diagnostics are plain-English and actionable.** Name the problem, then the fix:
  *"RAM below rated speed — running at 4800 MHz vs rated 6000. Enable EXPO/XMP in BIOS."*
  Never alarmist, never vague. Skip a check rather than guess ("skipped, never failed, when
  a sensor is absent — we never flag on missing data").
- **Honest about limits:** "0.1% lows are noisy at 60s captures"; signing is "version-stamp +
  defense-in-depth only." Hedge claims you can't back.
- **No emoji** in product UI or docs. No exclamation-mark marketing. No "blazing fast."
- **Vocabulary:** capture, run, log, ingest, frame-time, stutter, smoothness, percentile,
  1% / 0.1% low, distribution, verified, validated, snapshot, before/after.

Example copy that fits:
> *"Drag a CapFrameX, PresentMon, or MangoHud export. We parse it in your browser — no
> account needed."*
> *"Your 1% lows improved 16.7%. Enabling EXPO meaningfully reduced micro-stutters."*

---

## VISUAL FOUNDATIONS

The aesthetic is a **dark instrument panel** — the screen of a precision telemetry tool, not
a gamer-RGB product and not a generic SaaS dashboard. Calm near-black surfaces let dense,
colorful data do the talking.

- **Theme:** dark-first. `--bg-base #0b0e14` is the default canvas; a `[data-theme="light"]`
  override exists for marketing/docs/print. Elevation climbs void → base → raised → card.
- **Color is meaning, not decoration.** Neutrals carry 95% of the UI. Color appears only for
  data and status: smoothness tiers (`teal` avg / `blue` 1% / `violet` 0.1%), semantic
  good/warn/bad/info, and the categorical compare series.
- **Brand accent:** an **aurora teal `#2ee6c6`** (the watchman's all-seeing gaze). Used
  sparingly — primary CTAs, active states, the frame-time trace, focus rings.
- **The Bifröst ramp:** a teal→blue→violet→magenta gradient (Heimdall guards the rainbow
  bridge). Reserved for hero moments and continuous data scales — **never** as a flat button
  or card background. Avoid the generic blurple-gradient trap; this ramp is specific and earned.
- **Type:** *Space Grotesk* (display/headings, mechanical grotesque, tight tracking),
  *Hanken Grotesk* (UI/body, humanist), *JetBrains Mono* (**all** numerics — tabular figures,
  slashed zero, so columns of metrics align). Numbers in mono is a hard rule.
- **Spacing:** 4px base grid. **Dense** by default in the app (it's an instrument); generous
  section rhythm on marketing surfaces.
- **Radii:** small and precise — 6px buttons/inputs, 10px cards, 14px dialogs. Pills only for
  switches/avatars/meters. Nothing blobby.
- **Borders:** hairline white-alpha lines (`--line-1` 8% → `--line-3` 24%) instead of heavy
  strokes. Cards = 1px hairline border + soft ambient shadow + a 1px inner top highlight that
  reads as a beveled panel edge (`--elev-*`). Not flat, not glassy.
- **Backgrounds:** solid dark surfaces. No photographic hero imagery, no busy patterns. A
  faint optional grain/scanline texture token exists (`--texture-opacity`) but stays subtle.
  Charts sit in recessed **inset wells** (`--bg-inset`) so traces pop.
- **Shadows:** depth comes from the inner top-edge highlight + a soft drop shadow, *not* big
  blur. A restrained **teal glow** (`--glow-soft`) marks primary CTAs and live/capturing states.
- **Animation:** crisp and immediate — short durations (130–200ms), eased
  (`cubic-bezier(0.22,1,0.36,1)`), **no bounce**. Meters/chart fills ease in; nothing loops
  decoratively. Reduced-motion respected.
- **Hover:** surfaces lighten one step (`--bg-card → --bg-card-hover`), ghost controls pick up
  a faint white wash; interactive cards lift 1px. **Press:** primary darkens to `--press` and
  nudges down 0.5px (a physical "click"), never a shrink-scale.
- **Focus:** 2px teal ring (`--focus-ring`) with a base-color gap — always visible, never
  removed.
- **Transparency/blur:** only where it earns its keep — the sticky top bar and modal scrims
  use `--blur-md`. Surfaces themselves are opaque.
- **Imagery vibe:** cool, dark, technical. If photos are ever used, treat them cool/dim so the
  teal accent stays the warmest thing on screen.
- **Iconography:** Lucide line icons (see below). No emoji.

---

## ICONOGRAPHY

- **System:** [**Lucide**](https://lucide.dev) (MIT). Chosen as the natural pairing for the
  planned shadcn/Tailwind-adjacent stack; consistent ~1.5–2px stroke matches the hairline,
  instrument aesthetic. **This is a substitution** — no icon set was specified by the project.
- **Usage:** line (stroked) style only, `currentColor` so icons inherit text color. 16px in
  dense rows, 18–20px default, 24–28px for feature/empty-state moments.
- **Delivery:** CDN in the kits — `data-lucide="name"` + `lucide.createIcons()`. For
  production, install the `lucide-react` package. Inline `<svg>` is used inside a few
  primitives (checkbox tick, chevrons, stat arrows) so they ship without the icon runtime.
- **No emoji, no unicode-symbol icons** anywhere in product UI.
- **Common glyphs:** `activity` (frame-time), `gauge`, `cpu`, `zap`, `triangle-alert`
  (diagnostics), `shield-check` (verified/signed), `git-compare`, `upload` / `upload-cloud`,
  `share-2`, `radio` (live capture), `circle-help` (metric definitions).

### Logo

Proposed mark (no logo existed): a **sentinel aperture** (octagon = the all-seeing watchman)
containing a **frame-time trace** with a highlighted **detected spike** (the watchful eye).
Files in `assets/`:
- `logo-mark.svg` — full color (teal aperture + violet trace)
- `logo-mark-mono.svg` — single-color (`currentColor`); use on accent / monochrome contexts

---

## Index / manifest

**Root**
- `styles.css` — the single entry point consumers link (`@import`s all tokens + component CSS)
- `readme.md` — this file
- `SKILL.md` — Agent-Skill front-matter for use in Claude Code

**`tokens/`** — CSS custom properties (all reachable from `styles.css`)
- `colors.css` · `typography.css` · `spacing.css` · `effects.css` · `base.css` · `fonts.css`

**`assets/`** — `logo-mark.svg`, `logo-mark-mono.svg`

**`components/`** — reusable React primitives (exported on `window.HeimdallDesignSystem_da7d5f`)
- `core/` — Button, IconButton, Badge, Tag, Card, Stat, Avatar
- `forms/` — Input, Select, Switch, Checkbox, Segmented
- `feedback/` — Diagnostic, Meter, Tooltip, Spinner
- `navigation/` — Tabs
- Each component: `.jsx` (impl) · `.d.ts` (props/contract) · `.prompt.md` (usage). Shared
  styling lives in `components/components.css`.

**`guidelines/`** — foundation specimen cards (render in the Design System tab): colors,
type, spacing/radii/elevation/glow, brand logo & iconography.

**`ui_kits/`** — full-screen product recreations
- `web/` — Web Hub: run report, aggregate game page, upload, before/after compare
- `desktop/` — Tauri capture client (ready → capturing → complete)

---

## Caveats

- **Fonts are substitutes.** No brand fonts were provided; Space Grotesk / Hanken Grotesk /
  JetBrains Mono (all Google Fonts) were chosen to fit. Swap if a licensed face is selected.
- **Logo is proposed**, not official — designed from scratch since none existed.
- **Lucide is a substitution** for an unspecified icon set.
- **Charts in the kits are cosmetic SVG** stand-ins for the production D3 views.
- Everything is derived from **plans, not shipped UI** — the real apps didn't exist yet.
