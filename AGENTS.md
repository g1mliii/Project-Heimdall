# Heimdall — agent instructions

Open-source game benchmarking: capture frame-time data, share interactive reports, auto-diagnose
performance problems. Monorepo: Next.js web hub + (future) Tauri desktop client + shared TS packages.

**Roadmap:** [`IMPLEMENTATION_PLAN.md`](IMPLEMENTATION_PLAN.md) — phases 0–7.5 shipped; Phase 8
(Clerk accounts/auth, §20) is next. Code comments cite plan sections as `§n.n` — keep those
references intact when moving code. Load-bearing product rules:
[`docs/integrity-and-privacy.md`](docs/integrity-and-privacy.md).

## Commands

```bash
pnpm install                 # workspace deps (pnpm 11, Node 22/24 — see .node-version)
pnpm dev                     # builds @heimdall/ui, then next dev
pnpm migrate                 # apply infra/db migrations (node infra/db/migrate.mjs)
pnpm verify                  # lint + typecheck + test, all packages — the gate for every change
pnpm check:deps              # dependency minimum-age policy (must pass before adding deps)
pnpm audit:deps              # advisory audit, moderate+
pnpm --filter @heimdall/web test:e2e:functional   # Playwright minus @visual baselines
```

- Web tests import the **built** `@heimdall/ui` entrypoint (`dist/`). If UI tests fail on a clean
  checkout, run `pnpm --filter @heimdall/ui build` first (CI does).
- Integration tests need Postgres via `TEST_DATABASE_URL` (CI uses a `postgres:17` service;
  locally testcontainers or a local DB). R2-backed tests read `R2_*` env vars.
- Visual (`@visual`) Playwright baselines are platform-specific — don't regenerate them casually;
  functional e2e is the mandatory tier.

## Layout

```
apps/web/               Next.js hub — pages (/, /upload, /runs/[id], /games/[slug]) + API routes
  src/lib/repo/         Postgres repositories (parameterized SQL only)
  src/lib/jobs/         durable verification/reprocess workers (DB-queue claimed, never fire-and-forget)
  src/lib/upload/       browser parse → presigned Parquet PUT flow (§11)
apps/driver-curation/   scheduled driver-currency ingest (Phase 6.6)
apps/desktop/           empty until Phase 9 (Tauri 2)
packages/shared/        zod schemas, types, visibility/integrity/comparability — single source of truth
packages/parsers/       CapFrameX/PresentMon/MangoHud parsers + metrics + diagnostics (pure TS, runs in browser AND server)
packages/ui/            design system: tokens + primitives; reference lives in design/
infra/db/migrations/    numbered SQL, idempotent/reentrant (create ... if not exists, drop trigger if exists)
design/                 design-system source + ui_kits — the visual acceptance target per phase
```

## Invariants (violating these is a bug, not a style choice)

- **Never trust the client.** Uploaded summaries are provisional; the server recompute from stored
  Parquet is canonical (§11.5). Client signatures are tamper-evidence, never an acceptance gate.
- **Diagnostics/physics checks skip — never fail — on missing sensors.** No rule fires on absent
  or stale data (driver-currency rules self-suppress past their 30-day freshness window).
- **Aggregates pool only `public` + `validated` runs** — always via `isAggregateEligible` /
  `aggregateEligibilitySql` (`packages/shared/src/visibility.ts`). Never re-derive this predicate.
- **Outlier rejection and bell curves are inert below the cold-start threshold** (§17.4/§18.2) —
  thresholds are named constants in `packages/shared/src/integrity.ts`, never inline numbers.
- **Comparability** ("which runs may pool") lives only in `packages/shared/src/comparability.ts`.
- **Anonymous management tokens:** plaintext shown once; only the SHA-256 hash is stored;
  verification is constant-time (`packages/shared/src/tokens.ts`).
- **Hardware snapshots are quasi-identifying** — they follow the run through every deletion path
  (Postgres row + R2 objects together, never one without the other).
- **Parser golden fixtures:** every parseable fixture has a colocated `*.expected.json` whose
  numbers were **computed by hand**. New fixtures follow `packages/parsers/fixtures/README.md`;
  flipping a `SENSOR_AVAILABILITY` cell to `verified-real` requires the real export in the same PR
  (the flip-honesty test enforces it).
- **Hardware capability facts are declared upstream** (client/tool), never inferred from frames.

## Conventions

- TypeScript strict everywhere; ESLint per package; Vitest for unit, Playwright for e2e.
- **UI:** tokens and primitives from `@heimdall/ui` only — no raw hex/px/off-system fonts in app
  code; all numerics in JetBrains Mono (tabular). Build screens against the matching
  `design/ui_kits/**` recreation. Sentence case; no emoji in product UI or docs.
- **Copy voice:** technical, candid, plain-English, unit-suffixed numbers ("144.7 avg FPS"),
  actionable diagnostics ("RAM below rated speed — enable EXPO/XMP"), honest about limits.
- **SQL:** repositories use parameterized queries only; migrations are numbered, reentrant, and
  never edited after merge — add a new migration instead.
- **New dependencies:** exact-pinned versions; must satisfy `pnpm check:deps` (minimum-age soak);
  exceptions documented in root `package.json` `dependencyPolicy`.
- **Every fix lands with a regression test.** Phase gates in the plan list the expected suites.
- Dev environment is Windows (PowerShell); CI is ubuntu — keep scripts cross-platform (node/tsx,
  not bash-isms).
