# Heimdall — agent instructions

Open-source game benchmarking: capture frame-time data, share interactive reports, auto-diagnose
performance problems. Monorepo: Next.js web hub + Tauri desktop capture client (Windows and Linux)
+ shared TS packages.

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

pnpm --filter @heimdall/desktop vendor   # webfonts, + the pinned PresentMon sidecar on Windows (once)
pnpm --filter @heimdall/desktop dev     # Tauri capture client (Windows or Linux)
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml   # the Rust half
```

- The desktop client's Rust half has **two cfg-selected capture backends** behind one session
  contract: `win.rs`/`presentmon.rs` (PresentMon sidecar) and `linux.rs`/`mangohud.rs` (MangoHud log
  watcher, §23.1). Each keeps a "not available" stub for the other platform, so a checkout of either
  builds, lints and runs the whole suite — including the other platform's *pure* rules. What that
  cannot cover is the `#[cfg]`-ed-out platform halves, which is why CI has both a `desktop` (windows)
  and a `desktop-linux` (ubuntu) job. Keep platform-specific logic in Rust, and keep anything
  decidable without a syscall pure so both runners test it. See
  [`docs/desktop-client.md`](docs/desktop-client.md).

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
  src/lib/upload/       browser-held benchmark-set capability (the §11 flow itself lives in packages/ingest-client)
apps/driver-curation/   scheduled driver-currency ingest (Phase 6.6)
apps/desktop/           Tauri 2 capture client — React webview (src/) + Rust core (src-tauri/);
                        two cfg-selected backends: PresentMon sidecar (Windows), MangoHud watcher (Linux)
packages/shared/        zod schemas, types, visibility/integrity/comparability — single source of truth
packages/ingest-client/ the §11 create → PUT → finalize protocol, shared by web upload and desktop
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
