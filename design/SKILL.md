---
name: heimdall-design
description: Use this skill to generate well-branded interfaces and assets for Heimdall (open-source game-benchmarking platform — web hub + Tauri capture client), either for production or throwaway prototypes/mocks. Contains essential design guidelines, colors, type, fonts, assets, and UI kit components for prototyping.
user-invocable: true
---

Read the `readme.md` file within this skill, and explore the other available files.

Heimdall is a dark-first telemetry/instrument-panel design system for an open-source
game-benchmarking tool. The defining traits: near-black surfaces, an aurora-teal accent
(`#2ee6c6`), a Bifröst teal→blue→violet→magenta ramp used sparingly, all numerics in tabular
JetBrains Mono, hairline borders + soft elevation, and plain-English honest copy in sentence
case with no emoji.

Where to look:
- `styles.css` — the single stylesheet to link; pulls in every token via `@import`.
- `tokens/` — colors, typography, spacing, effects, base reset.
- `components/` — React primitives (`core/`, `forms/`, `feedback/`, `navigation/`), each with
  a `.jsx`, `.d.ts`, and `.prompt.md`. Shared styling in `components/components.css`.
- `guidelines/` — foundation specimen cards (colors, type, spacing, brand).
- `ui_kits/web/` and `ui_kits/desktop/` — full interactive screen recreations to copy from.
- `assets/` — logo marks.

If creating visual artifacts (slides, mocks, throwaway prototypes), copy assets out and create
static HTML files for the user to view — link `styles.css` and use the `.hd-*` classes + tokens
directly, or load the compiled component bundle. If working on production code, copy assets and
read the rules here to become an expert in designing with this brand.

If the user invokes this skill without other guidance, ask them what they want to build or
design, ask some questions, and act as an expert designer who outputs HTML artifacts _or_
production code, depending on the need.
