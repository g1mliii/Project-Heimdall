# design/ — design-system reference (read-only)

This folder is the **visual reference** for Heimdall. You **build against it**; you do **not**
import from it. The shipped, consumable design system lives in [`packages/ui`](../packages/ui).
The full design brief (voice, visual foundations, iconography, logo) is in [`readme.md`](readme.md).

| Here (`design/`) | vs | Shipped (`packages/ui`) |
|---|---|---|
| Full-screen recreations, specimens, docs, lint ruleset source | | Tokens + React primitives the apps import |
| Read as the acceptance target for each phase | | `import { ... } from '@heimdall/ui'` |

## Contents

- **`ui_kits/web/`** — full Web Hub screen recreations. Each maps to an implementation phase:
  | Screen | Phase |
  |---|---|
  | `RunPage.jsx` (run report) | 5 |
  | `extras.jsx` → `UploadPage` (drag-to-parse + batch) | 4 |
  | `GamePage.jsx` (distribution, filters, submissions table) | 7 |
  | `extras.jsx` → `ComparePage` (before/after) | 10 |
  | `screens.jsx` → `ExportPage` (video overlay) | 11 |
  | `screens.jsx` → `AccountPage` (Clerk, visibility, deletion) | 8 |
  | `charts.jsx` — cosmetic SVG stand-ins for the production **D3** views | 5/7/10 |
- **`ui_kits/desktop/`** — Tauri capture client (ready → capturing → complete). Phase 9.
- **`guidelines/`** — foundation specimen cards (color, type, spacing, brand, components).
- **`readme.md`** — the full design-system brief.
- **`SKILL.md`** — `heimdall-design` agent skill. Invoke it (or install into `.claude/skills/`)
  to design new UI in-brand.
- **`_ds_manifest.json` / `_ds_bundle.js`** — machine manifest + compiled component bundle (lets
  the `ui_kits` `index.html` files render standalone).

## How to use it while building

1. Open the matching `ui_kits` screen for the phase you're on (the acceptance target).
2. Rebuild it with **real `@heimdall/ui` components + D3**, not by copying `.hd-*` classes.
3. The phase's **Verify** gate includes "matches the `design/ui_kits` reference" — ideally a
   Playwright visual snapshot against it.

The charts in the kits are **cosmetic SVG**; production uses D3 (Phases 5/7/10).
