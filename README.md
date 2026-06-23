<h1 align="center">Project Heimdall</h1>

<p align="center">
  <em>Open-source game benchmarking that turns raw frame-time logs into beautiful, shareable, auto-diagnosing reports.</em>
</p>

---

Heimdall is a hybrid platform: a lightweight **desktop capture client** + a **web hub**. Press a
hotkey in-game, play for ~60 seconds, press it again — and get a shareable link to an interactive
report with frame-time graphs, smoothness tiers, a hardware snapshot, and **automated optimization
advice**. The web hub also ingests existing CapFrameX logs, so you can use it without installing
anything.

> **Status:** 🚧 Early development. See [`IMPLEMENTATION_PLAN.md`](IMPLEMENTATION_PLAN.md) for the
> roadmap and [`PLAN.md`](PLAN.md) for the architecture rationale.

## Why Heimdall

No existing tool combines **cross-platform capture** + **frictionless public interactive sharing**
+ **automated diagnostics**. CapFrameX/OCAT/FrameView capture but don't share; FlightlessMango
shares but is Linux-only and stagnant; HowManyFPS is closed and subscription-based. Heimdall is the
open hub in the middle.

## Features

- **Capture** — bundled Intel PresentMon (Windows) and MangoHud watcher (Linux/SteamOS), global hotkey.
- **Ingest existing logs** — drag-and-drop CapFrameX CSV/JSON; PresentMon and MangoHud logs too.
- **Interactive charts (D3.js)** — frame-time progression with stutter highlighting; Avg / 1% low /
  0.1% low smoothness tiers; frame-generation flags (DLSS 3 / FSR 3 / XeSS).
- **Auto-diagnostics** — driver-outdated, VRAM-saturation stutters, CPU bottleneck, RAM-below-rated-speed.
- **Statistical integrity** — bell-curve distributions instead of fakeable leaderboards; server-side
  telemetry physics checks; verified-reviewer tier.
- **Before/after validator** — tag two runs, get a plain-English delta.
- **Creator video export** — transparent WebM/PNG-sequence or green-screen MP4/WebM scrolling chart
  overlay synced to gameplay.

## Architecture

```
Desktop client (Tauri/Rust)  ─┐
  PresentMon / MangoHud       │
                              ▼
CapFrameX CSV (web upload) ─► Browser/client parse ─► Next.js API  metadata + jobs
                                                 ├─► Cloudflare R2 raw frames (Parquet) + video
                                                 ├─► Postgres      summaries + diagnostics
                                                 └─► ClickHouse    cross-run analytics (later)
                                                      │
                                      Next.js + D3.js dashboard
```

Full rationale (database choices, integrity model, competitor analysis) is in [`PLAN.md`](PLAN.md).

## Tech stack

Next.js · D3.js · TypeScript · PostgreSQL (Neon) · Cloudflare R2 · ClickHouse · Clerk · Tauri 2 (Rust) ·
Intel PresentMon · MangoHud · pnpm workspaces.

## Repository layout

```
apps/web/        Next.js dashboard + API route handlers
apps/desktop/    Tauri 2 capture client (Rust)
packages/shared/ cross-app types, zod schemas, fixtures
packages/parsers/ CapFrameX / PresentMon / MangoHud log parsers + metrics
infra/db/        Postgres migrations
infra/clickhouse/ ClickHouse DDL
docs/            documentation
```

## Development

> Tooling is being scaffolded per Phase 0–1 of the implementation plan.

```bash
pnpm install        # install workspace deps
pnpm dev            # run the web app
pnpm verify         # lint + typecheck + test
```

Copy [`.env.example`](.env.example) to `.env` and fill in your Neon, R2, and Clerk credentials.

## Contributing

Heimdall is open source for transparency — especially around how benchmark data is validated. The
roadmap is in [`IMPLEMENTATION_PLAN.md`](IMPLEMENTATION_PLAN.md); each phase lists its verification
and regression gates. Good first contributions: new diagnostics rules and parser support for more
log formats.

## License

[MIT](LICENSE) © 2026 Project Heimdall Contributors
