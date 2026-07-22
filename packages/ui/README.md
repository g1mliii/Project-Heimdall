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

Components are authored directly in TypeScript: `.tsx` (impl, typed props inline) + `.prompt.md`
(usage). `tsup` builds `dist/` (`pnpm --filter @heimdall/ui build`); `apps/web` imports the built
entrypoint, so run that build first on a clean checkout if web tests fail to resolve
`@heimdall/ui`. Fonts are self-hosted by the web app via `next/font/google` in
`apps/web/src/app/layout.tsx`, exposed as CSS variables that `src/tokens/typography.css` resolves
(see `src/tokens/fonts.css`). The adherence ruleset is wired into `apps/web`'s ESLint config as an
error-level rule set, so `pnpm lint` fails on drift.

## Updating the kit

The reference lives in `/design`. If the design system is re-issued, drop the new version there,
`git diff` to see what changed, and propagate token/component changes here — tokens are the only
place that should need editing for a palette/spacing change.
