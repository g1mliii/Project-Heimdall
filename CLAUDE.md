# CLAUDE.md

@AGENTS.md

Claude-specific notes:

- Before starting work, check the current phase in `IMPLEMENTATION_PLAN.md` and work its checkbox
  list top-down; tick items off and satisfy the phase's **Verify** / **Regression** sections before
  calling it done.
- `pnpm verify` is the gate for every change. If `@heimdall/ui` imports fail in tests, build it
  first: `pnpm --filter @heimdall/ui build`.
- Don't renumber or strip `§n.n` plan references in code comments — they are the index back into
  `IMPLEMENTATION_PLAN.md`.
- For UI work, load the design skill in `design/SKILL.md` and match the relevant
  `design/ui_kits/**` recreation.
