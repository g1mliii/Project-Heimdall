# Driver-Currency Curation (Phase 6.6 design)

Implementation record for the automated driver-data service that feeds the Phase 6
`gpu-driver-outdated` rule and the Phase 6.6 `driver-update-available` rule. Phase 6 shipped against a tiny hand-seeded
`games.required_driver` column (migration `0012_seed_required_drivers.sql`). That
seed is a **staleness treadmill** — the exact failure mode IMPLEMENTATION_PLAN
§15.4 warns about ("the failure mode that rotted FlightlessMango"). This phase
replaces manual seeding with a scheduled ingest, and broadens coverage to every
OS × vendor combination we care about.

Both rules are safe against staleness: repository reads select a vendor/OS row
only when `game_driver_requirements.fetched_at` or `driver_catalog.fetched_at`
is within its 30-day freshness window. They therefore **self-suppress when the
curated value is absent or stale**, so partial or missing data never produces a
false positive. That property is what makes best-effort automation acceptable —
we automate the common cases and leave the long tail null.

## Scope

Support the following capture environments (from the desktop client + existing
CapFrameX/PresentMon/MangoHud imports):

| OS | Vendor | "Driver" that matters | Game-ready mapping exists? |
| --- | --- | --- | --- |
| Windows | NVIDIA | GeForce Game Ready / Studio driver (`610.xx`) | Yes (per-game, strong) |
| Windows | AMD | Adrenalin (`26.6.4` + WHQL wrapper) | Yes (per-game, in release notes) |
| Windows | Intel | Arc/Iris Xe graphics driver (`32.0.101.xxxx`) | Partial (release notes) |
| Linux | NVIDIA | Proprietary Unix driver (`595.xx`) | No (lean on currency) |
| Linux | AMD | **Mesa/RADV** (`26.1.x`) + kernel | No (lean on currency) |
| Linux | Intel | **Mesa/ANV/Iris** (`26.1.x`) + kernel | No (lean on currency) |

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

## Confirmed sources per cell

The implementation fixtures are reduced copies of responses fetched from these
official sources, plus the discovery API described below, on 2026-07-13. A
source is not allowed to update the catalog unless its version, release date,
and vendor-hosted details URL all validate.

### Currency (latest driver)

- **NVIDIA (Windows):** the public GeForce lookup service at
  `gfwsl.geforce.com/.../AjaxDriverService.php` with `osID=57` and `dch=1`.
  It returns JSON with a version, release date, vendor details URL, and encoded
  release notes, and is reachable without GeForce Experience authentication.
- **NVIDIA (Linux):** the vendor-hosted
  `download.nvidia.com/XFree86/Linux-x86_64/latest.txt` pointer plus its
  generated release directory. The pointer provides the stable display-driver
  version and artifact path; the directory provides its release date.
- **AMD (Win):** Adrenalin release notes at the predictable pattern
  `https://www.amd.com/en/resources/support-articles/release-notes/RN-RAD-WIN-<ver>.html`
  (version in URL; game-ready releases list newly-supported games). AMD's Vulkan
  support index can lag hotfix releases — it still listed `26.6.1` when the
  official `26.6.4` page was current. Changelog.gg's public driver-record API is
  therefore used as a discovery-only input: the Worker accepts only stable AMD
  records whose version, release date, and `sourceUrl` agree and whose URL is the
  matching AMD-hosted release-note path. The Worker then fetches the AMD product
  download page named by that record and requires its version, release date, and
  release-note link to agree before it persists anything. This avoids depending
  on the release-note page for currency when that page times out. Only AMD's
  independently parsed release notes supply game-ready mappings. The official
  index remains independent, and the dated fallback remains the final safety net.
- **Intel (Win):** Arc & Iris Xe graphics driver release notes on intel.com;
  Intel Driver & Support Assistant surface.
- **AMD/Intel (Linux) = Mesa:** latest Mesa release from
  `https://docs.mesa3d.org/` / the `mesa/mesa` GitLab tags (e.g. `25.2.x`).
- **Fallback:** only the committed AMD/Intel CSV is accepted. Third-party data
  never replaces an official source URL or supplies game-ready requirements.

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
  released_at   date
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
                  existing games and aliases using the same normalization
                  contract; conservative token-overlap is allowed only when
                  there is a unique best candidate
  record fetched_at; log coverage + anything dropped (no silent truncation)
```

- **Idempotent upserts** keyed as above; re-running is a no-op.
- **No release rollback:** a response with an older `released_at` cannot replace
  a newer catalog or game requirement, even if its fetch timestamp is newer.
- **Staleness → suppress, never guess.** The rule ignores catalog/requirement
  rows whose `fetched_at` is older than a TTL, matching §15.4.
- **Scraping fragility:** AMD/Intel data is HTML, not a feed. Back it with a
  community-maintained CSV committed in-repo that the job also ingests, so
  coverage survives a page-layout change.

## How the rule consumes it

The verification worker (`verify-run.ts`) already resolves the run's game and
passes `game.requiredDriver` into `runDiagnostics`. Extend that read
(`readRunRequiredDriver` in `apps/web/src/lib/db.ts`) to key on
`(vendor, os)` against `game_driver_requirements`, and add a second read for the
`driver_catalog` currency baseline. Both rules degrade to no-op when their row is
absent or stale. On Linux, the vendor→component mapping picks `mesa` for AMD/Intel
and `gpu` for NVIDIA.

## Implementation confirmations

- NVIDIA Windows returns JSON without GeForce Experience authentication.
  NVIDIA Linux's generic lookup was product-branch-sensitive, so the Worker
  uses the vendor's architecture-wide `latest.txt` pointer instead.
- AMD and Intel are HTML contracts. Fixture-backed parsers fail closed when the
  expected headings disappear, while the dated CSV fallback preserves known
  coverage without being re-stamped indefinitely. AMD `26.6.4` is a confirmed
  hotfix with no New Game Support section, so it advances only the currency
  catalog; the `26.6.1` per-game requirements remain intact. Changelog.gg adds
  one bounded public-API request inside the existing weekly job, so it consumes
  no additional Cloudflare Cron Trigger and fails independently.
- MangoHud's sysinfo `driver` column preserves strings such as
  `Mesa 26.1.4`; a golden parser fixture locks that contract.
- The Worker uses manual redirects with an HTTPS host allowlist, a 15-second
  whole-response timeout, a 2 MiB streaming body cap, and redacted top-level
  failures. Each source settles independently.
- Repository reads impose a 30-day freshness TTL and a seven-day release grace
  period. Missing, stale, unsupported, and newly released rows all no-op.

## Cloudflare capacity preflight

Before implementation, Wrangler confirmed this account was on the Standard
usage model with 6 existing Cron Triggers. Cloudflare's published paid limit is
250 Cron Triggers, so one dedicated weekly trigger is viable. The Worker runs at
`17 6 * * 1` (Mondays at 06:17 UTC); its schedule remains isolated from the web
application.

## Sources

- [Cloudflare Workers limits](https://developers.cloudflare.com/workers/platform/limits/) · [Cron Triggers](https://developers.cloudflare.com/workers/configuration/cron-triggers/)
- [NVIDIA GeForce drivers](https://www.nvidia.com/en-us/geforce/drivers/) · [Game Ready Drivers](https://www.nvidia.com/en-us/geforce/game-ready-drivers/) · [GFE supported games](https://www.nvidia.com/en-us/geforce/geforce-experience/games/)
- [AMD Adrenalin 26.6.4 release notes](https://www.amd.com/en/resources/support-articles/release-notes/RN-RAD-WIN-26-6-4.html)
- [Changelog.gg AMD driver records](https://changelog.gg/drivers/amd-radeon-adrenalin-driver) · [public API schema](https://changelog.gg/openapi.json) · [methodology](https://changelog.gg/methodology)
- [Intel Arc Graphics Windows driver](https://www.intel.com/content/www/us/en/download/785597/intel-arc-graphics-windows.html)
- [Mesa release notes](https://docs.mesa3d.org/relnotes.html)
