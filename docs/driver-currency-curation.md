# Driver-Currency Curation (Phase 6.6 design)

Background for the automated driver-data service that feeds the Phase 6
`gpu-driver-outdated` rule. Phase 6 shipped that rule against a tiny hand-seeded
`games.required_driver` table (migration `0012_seed_required_drivers.sql`). That
seed is a **staleness treadmill** — the exact failure mode IMPLEMENTATION_PLAN
§15.4 warns about ("the failure mode that rotted FlightlessMango"). This phase
replaces manual seeding with a scheduled ingest, and broadens coverage to every
OS × vendor combination we care about.

The Phase 6 rule is already safe against staleness: it is vendor-gated and the
repository passes it a value only when `games.required_driver_checked_at` is
within its 30-day freshness window. It therefore **self-suppresses when the
curated value is absent or stale**, so partial or missing data never produces a
false positive. That property is what makes best-effort automation acceptable —
we automate the common cases and leave the long tail null.

## Scope

Support the following capture environments (from the desktop client + existing
CapFrameX/PresentMon/MangoHud imports):

| OS | Vendor | "Driver" that matters | Game-ready mapping exists? |
| --- | --- | --- | --- |
| Windows | NVIDIA | GeForce Game Ready / Studio driver (`580.xx`) | Yes (per-game, strong) |
| Windows | AMD | Adrenalin (`25.9.1` + WHQL `32.0.xxxxx`) | Yes (per-game, in release notes) |
| Windows | Intel | Arc/Iris Xe graphics driver (`32.0.101.xxxx`) | Partial (release notes) |
| Linux | NVIDIA | Proprietary Unix driver (`580.xx.yy`) | No (lean on currency) |
| Linux | AMD | **Mesa/RADV** (`25.2.x`) + kernel | No (lean on currency) |
| Linux | Intel | **Mesa/ANV/Iris** (`25.2.x`) + kernel | No (lean on currency) |

Key insight: on **Linux the "driver" for AMD/Intel is Mesa**, not a vendor
package. MangoHud already reports the Mesa/driver string in its sysinfo row, so
the captured value is available; we just need a Mesa-currency baseline to compare
against. NVIDIA on Linux ships a proprietary driver with its own version line.

**Optional / lower priority (chipsets):** AMD Chipset Software (`6.x`) and Intel
Chipset Device Software (INF). These correlate weakly with per-game performance,
so they should feed a passive "system is up to date" surface, **not** a game-ready
rule. Capture-and-display only; no diagnostic that fires on them at first.

## Two signals, not one

Split the single "outdated driver" idea into two independent findings so most of
it needs **no curation at all**:

1. **`driver-update-available` (info) — currency, fully automatable.** Fires when
   the captured driver trails the *latest known* driver for that
   OS × vendor × component by more than a threshold (N releases or M days). Needs
   only a "latest driver" catalog, which every vendor publishes. Works on all six
   cells above, including Linux/Mesa. Zero game mapping.

2. **`gpu-driver-outdated` (info) — game-ready minimum, best-effort.** The existing
   rule: captured driver is older than the driver that first shipped game-ready
   support for *this title*. Needs per-game data; only Windows NVIDIA/AMD/Intel
   have it. Best-effort, self-suppressing.

Both reuse `compareDriverVersions` (numeric-segment compare, already in
`packages/parsers/src/diagnostics/gpu-driver-outdated.ts`) so ingest and rule
share one comparator and can never disagree.

## Sources per cell

Confirm exact response shapes at implementation (WebFetch was rate-limited when
this was drafted); URLs and formats below are from search + prior knowledge.

### Currency (latest driver)

- **NVIDIA (Win + Linux):** official driver-lookup API
  `https://www.nvidia.com/Download/API/driverSearch.aspx` — query by device id
  (`devid`), OS (`osv`/`os64`), language; returns structured driver metadata
  (version, release date, WHQL, download URL). Different `os` param selects the
  Linux driver line. Linux archive index as a fallback:
  `https://download.nvidia.com/XFree86/Linux-x86_64/`.
- **AMD (Win):** Adrenalin release notes at the predictable pattern
  `https://www.amd.com/en/resources/support-articles/release-notes/RN-RAD-WIN-<ver>.html`
  (version in URL; page lists newly-supported games). Latest-driver index page
  links the newest.
- **Intel (Win):** Arc & Iris Xe graphics driver release notes on intel.com;
  Intel Driver & Support Assistant surface.
- **AMD/Intel (Linux) = Mesa:** latest Mesa release from
  `https://docs.mesa3d.org/` / the `mesa/mesa` GitLab tags (e.g. `25.2.x`).
- **Vendor-neutral mirrors (fallback/cross-check):** TechPowerUp driver database,
  `patchbot.io/drivers/nvidia-geforce`.

### Game-ready minimum (per game, Windows)

- **NVIDIA:** Game Ready Driver news pages
  `https://www.nvidia.com/en-us/geforce/news/<date>-geforce-game-ready-driver/`
  (each states "Game Ready for X"); GeForce Experience per-game optimization data
  via the `gfwsl.geforce.com` backend; supported-games list
  `https://www.nvidia.com/en-us/geforce/geforce-experience/games/`.
- **AMD:** the same Adrenalin release-notes pages list newly-supported titles
  alongside the version.
- **Intel:** Arc driver release notes list game-support additions.

## Data model

Generalize past the single `games.required_driver` text column.

```
driver_catalog                    -- currency baseline (curation-free)
  vendor        text   -- 'nvidia' | 'amd' | 'intel'
  os            text   -- 'windows' | 'linux'
  component     text   -- 'gpu' | 'mesa' | 'chipset'
  gpu_series    text   -- optional; some vendors branch by family (nullable)
  latest_version text
  released_at   date
  source_url    text
  fetched_at    timestamptz        -- staleness gate for the rule
  primary key (vendor, os, component, coalesce(gpu_series,''))

game_driver_requirements          -- game-ready minimum (best-effort)
  game_id       bigint references games(id)
  vendor        text
  os            text
  min_version   text
  source_url    text
  fetched_at    timestamptz
  primary key (game_id, vendor, os)
```

Migrate the existing `games.required_driver` seed into
`game_driver_requirements` (vendor=nvidia, os=windows) so nothing is lost, then
retire the column (or keep it as a denormalized Windows/NVIDIA shorthand — decide
at implementation).

## Scheduled job

A cron-triggered ingest (a Cloudflare cron Worker fits the stack; alternatively a
Next.js route behind an external scheduler). Weekly is plenty — driver cadence is
~monthly.

```
for each source (independent, failures isolated):
  fetch → parse → normalize version → upsert
    - currency  → driver_catalog   (vendor, os, component)
    - game-ready→ game_driver_requirements, fuzzy-matching the title to
                  games.slug via the EXISTING alias machinery (resolveGameId
                  style) so we reuse one canonicalization path
  record fetched_at; log coverage + anything dropped (no silent truncation)
```

- **Idempotent upserts** keyed as above; re-running is a no-op.
- **Staleness → suppress, never guess.** The rule ignores catalog/requirement
  rows whose `fetched_at` is older than a TTL, matching §15.4.
- **Scraping fragility:** AMD/Intel data is HTML, not a feed. Back it with a
  community-maintained CSV committed in-repo that the job also ingests, so
  coverage survives a page-layout change.

## How the rule consumes it

The verification worker (`verify-run.ts`) already resolves the run's game and
passes `game.requiredDriver` into `runDiagnostics`. Extend that read
(`readRunRequiredDriver` in `apps/web/src/lib/repo/catalog.ts`) to key on
`(vendor, os)` against `game_driver_requirements`, and add a second read for the
`driver_catalog` currency baseline. Both rules degrade to no-op when their row is
absent or stale. On Linux, the vendor→component mapping picks `mesa` for AMD/Intel
and `gpu` for NVIDIA.

## Open confirmations (do at implementation)

- Exact response format (XML vs JSON) and Linux `os` id of `driverSearch.aspx`.
- Whether the `gfwsl.geforce.com` per-game endpoint is reachable without GFE auth.
- Stability of AMD/Intel release-notes HTML (drives how much CSV fallback we need).
- Mesa → per-vendor version reporting: confirm MangoHud's captured `driver` string
  format so `compareDriverVersions` segments it correctly.

## Sources

- [NVIDIA driver-search API](https://www.nvidia.com/Download/API/driverSearch.aspx?dtid=1&os64=0&osv=5.1&lid=1033&devid=0611&islt=0)
- [NVIDIA GeForce drivers](https://www.nvidia.com/en-us/geforce/drivers/) · [Game Ready Drivers](https://www.nvidia.com/en-us/geforce/game-ready-drivers/) · [GFE supported games](https://www.nvidia.com/en-us/geforce/geforce-experience/games/)
- [NVIDIA Game Ready Driver news example](https://www.nvidia.com/en-us/geforce/news/june-16-2026-geforce-game-ready-driver/)
- [AMD Adrenalin release notes example (25.9.1)](https://www.amd.com/en/resources/support-articles/release-notes/RN-RAD-WIN-25-9-1.html)
- [Mesa docs](https://docs.mesa3d.org/)
- [PatchBot NVIDIA driver patch notes](https://patchbot.io/drivers/nvidia-geforce) · [TechPowerUp driver news](https://www.techpowerup.com/)
