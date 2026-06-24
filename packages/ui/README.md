# @heimdall/ui

The Heimdall design system — **the single source of truth for all UI.** Apps consume it; they
never re-implement tokens or re-apply raw `.hd-*` classes.

Authored by the `heimdall-design` system (dark instrument-panel aesthetic: near-black surfaces,
aurora-teal accent `#2ee6c6`, Bifröst ramp used sparingly, all numerics in JetBrains Mono).

## Consume it

```ts
// once, in the app's root layout:
import '@heimdall/ui/styles.css';

// anywhere:
import { Button, Card, Stat, Diagnostic, Meter, Badge, Tabs } from '@heimdall/ui';
```

- **Tokens** (`src/tokens/*.css`, surfaced via `src/styles.css`) are the only place colors,
  spacing, type, radii, and effects are defined. Use them via `var(--token)`.
- **Components** (`src/components/**`) are class wrappers over `src/components/components.css`.
  Import them from the package root (`@heimdall/ui`), never deep paths.

## The no-drift rules (enforced, not just hoped)

1. **No raw values in app code** — no hex colors, no `px`, no off-system fonts. Use tokens.
2. **Import primitives from `@heimdall/ui`** — never from component internals.
3. **`adherence.oxlintrc.json`** ships those rules + each component's prop contract. Wire it into
   the lint gate (Phase 1 §3a) so violations fail `pnpm lint`.
4. **Build each screen against `/design`** — the `design/ui_kits/**` recreations are the visual
   acceptance target for the matching implementation phase.

## Status / porting

Components are vendored as authored: `.jsx` (impl) + `.d.ts` (prop contract) + `.prompt.md`
(usage). **Phase 1 §3a** finalizes the TS conversion, fonts, and build wiring when `apps/web`
first imports the package. Until then this package has no build/test scripts (so it no-ops in
`pnpm -r`). The contracts in the `.d.ts` files are stable — code against those.

## Updating the kit

The reference lives in `/design`. If the design system is re-issued, drop the new version there,
`git diff` to see what changed, and propagate token/component changes here — tokens are the only
place that should need editing for a palette/spacing change.
