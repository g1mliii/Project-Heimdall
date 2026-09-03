# Heimdall Implementation Plan

> **Reconstructed 2026-07-20.** The original plan file was lost; this version was rebuilt from the
> section references (`§n.n`) scattered through code comments, migrations, docs, the design kits,
> and the phase-tagged git history. Phases 0–7.5 are recorded as shipped (summarized, with the
> evidence). Phases 8+ are the remaining roadmap, restored to the original numbering:
> **Phase 8 = accounts/auth (§20), Phase 8.5 = comprehensive security review, Phase 9+ = desktop
> client, Phase 10 = before/after validator, Phase 11 = video export, Phase 12 = ClickHouse.**
> Where an original `§` number is known it is kept so existing code comments keep resolving.

## Context

A PC gamer who wants to know "is my machine running this game well, and how do I fix it if not?"
must stitch together capture tools (CapFrameX/OCAT/PresentMon), forum folklore for diagnostics,
and screenshots for sharing. No existing tool combines **cross-platform capture + frictionless
public interactive sharing + automated diagnostics**. CapFrameX captures but doesn't share;
FlightlessMango shares but is Linux-only and stagnant; HowManyFPS is closed and subscription-based.

Heimdall fills that gap: a hybrid platform — a lightweight **desktop capture client** (Tauri 2)
plus a **web hub** (Next.js + D3). Press a hotkey in-game, play ~60 seconds, press it again, get a
shareable link to an interactive report: frame-time chart with stutter highlighting, smoothness
tiers (avg / 1% low / 0.1% low), hardware snapshot, and plain-English optimization advice. The web
hub also ingests existing CapFrameX/PresentMon/MangoHud logs, so it works with no install.

Load-bearing product rules live in [`docs/integrity-and-privacy.md`](docs/integrity-and-privacy.md)
(never trust the client; signatures are tamper-evidence, not proof; checks skip — never fail — on
missing sensors; visibility × validation gates every aggregate).

---

## Tech Stack

| Layer | Technology | Justification |
|-------|-----------|---------------|
| Web hub | Next.js (App Router) + TypeScript strict | SEO for game pages, RSC for data-heavy report pages |
| Charts | D3.js | Frame-time progression, distributions, zoom/pan, stutter markers |
| Design system | `@heimdall/ui` (vendored from `design/`) | Dark instrument-panel aesthetic; tokens are the single source of truth; numerics in JetBrains Mono |
| Validation | Zod (`packages/shared`) | Runtime + inferred types shared across web, parsers, desktop |
| Database | PostgreSQL (Neon) | Run summaries, dictionaries, diagnostics, jobs; at-rest encryption stays ON (§1.5) |
| Object storage | Cloudflare R2 | Raw per-frame Parquet (`runs/{id}/{nonce}.parquet`); `exports/` prefix reserved for Phase 11 video |
| Analytics DB | ClickHouse (**Phase 12** — env vars stubbed, `infra/clickhouse/` empty until then) | Cross-run/population analytics too heavy for Postgres |
| Auth | Clerk (**Phase 8** — env keys stubbed in `.env.example`) | Accounts, private runs, run management, verified-reviewer tier |
| Desktop client | Tauri 2 (Rust) — Windows shipped in **Phase 9**, `apps/desktop` | Bundled Intel PresentMon (Windows), MangoHud watcher (Linux/SteamOS), global hotkey, Ed25519-signed uploads |
| Parsing | `packages/parsers` — pure TS, runs in browser and server | Same code parses client-side (upload preview) and server-side (canonical recompute) |
| Testing | Vitest (unit), Playwright (e2e + visual baseline), golden fixtures | Every parseable fixture has a hand-computed `*.expected.json` |
| CI | GitHub Actions (`ci.yml`, `release.yml`) | verify + migrations + e2e; Windows job runs cargo fmt/clippy/test and builds the Tauri bundle |
| Monorepo | pnpm workspaces | `apps/*` + `packages/*` + `infra/*`; dependency minimum-age policy in `scripts/check-dependency-policy.mjs` |

---

## Repository layout (current)

```text
apps/web/              Next.js hub: pages (/, /upload, /runs/[id], /games/[slug]) + API routes
apps/desktop/          Tauri 2 Windows capture client (Phase 9) — React webview + Rust core
apps/driver-curation/  scheduled driver-currency ingest (Phase 6.6)
apps/steam-ingest/      Phase 8.7 Steam ingest worker (4 cron lanes -> Postgres)
apps/steam-pics/        Phase 8.8b PICS build-identity collector (GitHub Actions job)
packages/shared/       zod schemas, types, visibility/integrity/comparability primitives, fixtures
packages/parsers/      CapFrameX / PresentMon / MangoHud parsers, metrics, diagnostics rules
packages/ui/           vendored design system (tokens + components) — §3a TS conversion still open
infra/db/              Postgres migrations (0001…0028) + migrate.mjs
infra/r2/              R2 bucket layout + key policy
infra/clickhouse/      empty until Phase 12
design/                design-system reference + ui_kits (visual acceptance targets per phase)
docs/                  integrity-and-privacy.md (§0.5, §1.1–1.5), driver-currency-curation.md (Phase 6.6)
```

---

## Hard invariants (do not regress)

- **Never trust the client.** Public numbers are provisional until the durable server job
  recomputes the summary from the stored Parquet (§11.5). Recomputed is canonical.
- **Signatures are tamper-evidence only** (§0.5). `signature_valid` is recorded as evidence and
  never gates acceptance. Never advertise signing as anti-cheat.
- **Checks skip, never fail, on missing sensors.** No diagnostic or physics check fires on absent
  data. Same for driver-currency rules: they self-suppress when curated data is stale (>30 days).
- **Aggregate eligibility = `public` AND `validated`** — enforced by `isAggregateEligible` /
  `aggregateEligibilitySql` in `packages/shared/src/visibility.ts`. Unlisted/private never pool.
- **Outlier rejection is inert below `MIN_SAMPLE_THRESHOLD`** (§17.4/§18.2) — a cold dataset never
  auto-hides legitimate runs, and never renders a bell curve below the cold-start threshold (~30).
- **Anonymous delete tokens are hashed** (SHA-256, constant-time verify); plaintext shown once,
  never stored (§1.2).
- **Hardware snapshots are quasi-identifying** (§1.4) — they follow the run through deletion and
  must appear in the privacy policy (Phase 8 §20.4 / Phase 12).
- **Design tokens only** — no raw hex/px in app code; primitives imported from `@heimdall/ui`;
  screens are built against the matching `design/ui_kits/**` recreation.
- **Dependency policy** — new deps must pass `pnpm check:deps` (minimum-age soak) and
  `pnpm audit:deps`.

---

## Quality gates

```bash
pnpm install          # workspace deps
pnpm dev              # build @heimdall/ui, run web dev server
pnpm migrate          # apply infra/db migrations
pnpm verify           # lint + typecheck + test (all packages)
pnpm audit:deps       # advisory audit (moderate+)
pnpm check:deps       # dependency minimum-age policy
# e2e: playwright suites in apps/web/e2e (run.spec.ts, game.spec.ts + visual baselines)
```

Every phase ends with `pnpm verify` green, migrations idempotent/reentrant, and e2e passing.

---

## Phases 0–7.5 — SHIPPED (summary)

> Kept as a checked summary so section references (`§n`) in code keep resolving. Evidence:
> phase-tagged commits `1803f9b … fd9a09f`, migrations 0001–0028.

- [x] **Phase 0 — Foundation (§0):** pnpm monorepo, CI (`§0.8` — includes the dormant Tauri job),
  dependency policy script, integrity/privacy doc (`§0.5`), design system dropped into `design/`.
- [x] **Phase 1 — Shared primitives + design system (§1–§3):** visibility model (`§1.1`),
  hashed management/delete tokens (`§1.2`), integrity thresholds as named constants (`§1.3`),
  fingerprint privacy stance (`§1.4`), encryption posture (`§1.5`); shared domain types/schemas
  (`§2.1–2.4`); `packages/ui` vendored (`§3`).
  - [x] **§3a (carried debt):** components are `.tsx` built by tsup; font wiring
    (`next/font/google` in `apps/web/src/app/layout.tsx`) and the `adherence.oxlintrc.json` lint
    gate (`apps/web/eslint.config.mjs`, error-level) were already in place; closed the remaining
    stale-doc gap in `packages/ui/README.md` as Phase 8 task 20.0.
- [x] **Phase 2 — Data layer (§4–§6):** Postgres dictionaries with canonical hardware/game ids
  (`§4.4–4.5`), R2 helpers + key policy (`§5`, `exports/` reserved for Phase 11), runs schema,
  numeric-integrity constraints, durable verification-job queue (migration 0003).
- [x] **Phase 3 — Parsers + metrics (§7–§10):** CapFrameX CSV/JSON (`§7`, the launch wedge),
  PresentMon v1/v2 + MangoHud (`§8`), metrics engine with the single stutter predicate (`§9`),
  typed malformed-input errors (`§10`), sensor-availability matrix with provenance flips (`§7.3`,
  procedure `16a.1` in `packages/parsers/fixtures/README.md`).
- [x] **Phase 4 — Ingest (§11–§12):** browser-side parse → provisional summary → presigned Parquet
  PUT straight to R2 (`§11.1–11.4`), batch multi-file upload (`§11.8`), upload limits (`§11.10`),
  server recompute-as-canonical (`§11.5`), ingest API + run persistence, per-IP rate limits,
  finalize recovery, deletion via hashed token.
- [x] **Phase 5 — Run page (§13–§14):** shareable `/runs/[id]` with D3 frame-time chart
  (zoom/pan, stutter markers), smoothness tiers, TopBar shell, deterministic synthetic frame
  fixture generator (`§14`), e2e + visual baselines.
- [x] **Phase 6 — Diagnostics engine (§15):** rule engine + `gpu-driver-outdated`, bottleneck
  attribution, plain-English actionable findings; skip-never-fail rule context.
- [x] **Phase 6.5 — Telemetry readiness & reproducible methodology (§16, §16a–§16c):** capability
  manifest (`§16a`), methodology manifest + benchmark sets + comparability columns (`§16c`),
  graphics-API comparability (`§16d`).
- [x] **Phase 6.6 — Driver-currency curation:** `apps/driver-curation` scheduled ingest for
  NVIDIA/AMD/Intel × Windows/Linux (Mesa), 30-day freshness self-suppression — kills the
  "staleness treadmill" `§15.4` warned about. Design record: `docs/driver-currency-curation.md`.
- [x] **Phase 6.7 — Run reprocessing (§16e):** bounded historical reprocess jobs (migration 0026),
  driver-finding refresh sweeps, never reprocess a pending run.
- [x] **Phase 7 — Game pages, search, statistical integrity (§17–§18):** `/games/[slug]` shell +
  catalog search, distribution pages with cold-start threshold (`§17.4`) and workload
  comparability filter (`§17.5`), telemetry-physics checks + MAD outlier rejection in the verify
  job (`§18.1–18.3`), submissions table hardening + filtered-page indexes.
- [x] **Phase 7.5 — Aggregate cohort distributions:** cohort assessments, bounded distribution
  reads. Merged to main via PR #8 (`e8553c2`).
- [x] **Carried debt — real homepage + root 404 (found during Phase 8 manual testing):** `/` was
  still the Phase 1 throwaway primitives demo ("Replaced by the real dashboard in Phase 5" never
  happened) — replaced with real hero copy + upload CTA + feature cards, no fabricated data.
  `app/not-found.tsx` added (there was no root 404 — only the run-scoped one — so any bad URL hit
  Next's unstyled default page). `e2e/home.spec.ts` assertions updated to match; its `@visual`
  screenshot baseline was deleted (stale, content changed) and needs regenerating on a machine
  with Docker (`pnpm --filter @heimdall/web test:e2e --update-snapshots`) — not run here, this
  sandbox has no Testcontainers/Docker for the e2e global setup.

---

## Phase 8: Accounts, Auth & Run Management (Clerk) — §20

> Everything so far works anonymously (unlisted-by-default, hashed delete tokens). Phase 8 adds
> real ownership: Clerk sign-in, true `private` visibility, run management, the verified-reviewer
> trust anchor, moderation, and the right-to-erasure path. The visual acceptance target is
> `AccountPage` in `design/ui_kits/web/screens.jsx` (§20).
>
> Groundwork already in place: `users.id` is a Clerk-shaped `text` PK (migration 0001);
> `verifications` table exists (migration 0003); `runs.user_id` is nullable-for-anonymous;
> `visibility.ts` models `private` but pre-auth code never mints it; `.env.example` has
> `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` / `CLERK_SECRET_KEY`; repo tests carry a
> "Phase 8 adds owner authorization" expectation.
>
> **Design decisions locked (2026-07-20, detailed plan on file):** middleware via Next 16
> `proxy.ts` + `clerkMiddleware()` protecting ONLY `/account` + `/admin` (everything else stays
> public; API routes decide their own 401/404); one identity seam `lib/api/auth.ts` (`getViewer()`)
> so repos stay Clerk-free; the single visibility gate `isPreAuthVisible` → `isVisibleTo(run,
> viewer)` in `repo/runs.ts`; rate-limit keys become `user:{id}` when signed in else `ip:{ip}`
> (with `cf-connecting-ip` support + one `RATE_LIMIT_AUTHED_MULTIPLIER` env); `users.role` is the
> query-time source of truth for the verified tier (`verifications` = grant/audit record, written
> atomically with role); erasure order is R2 objects → run rows → user row LAST (the users→runs
> cascade FK makes any other order orphan R2 objects); moderation gets a new `moderated` run
> status (migration 0034) + `reports` table (0035); tests mock the `lib/api/auth` seam, never
> Clerk, with a route × {anon, owner, non-owner, admin} authz matrix.

> **Status (2026-07-21): COMPLETE — every checklist item shipped and verified**, including the
> Playwright e2e tier once Docker became available mid-session. 379/382 Vitest web tests passing
> against a real Neon Postgres (3 skipped are Docker-only-but-now-Docker-is-available, not broken),
> 22/22 Playwright e2e tests green (`--workers=1`), `pnpm verify` green across the whole workspace,
> migrations `0034`/`0035` applied and confirmed reentrant. Verified live in a real browser against
> a real Clerk session for the auth/upload/visibility/delete flows, and via the new
> `account.spec.ts` for the full sign-in → private-upload → toggle-public → game-page pipeline
> against a real Clerk dev instance + real R2. See the Regression section below for what turning
> Docker on also surfaced (a reparse-point discovery bug + a parallel-execution flake, both fixed).

- [x] 20.0 Close out **§3a** (smaller than first thought — components are already `.tsx` + tsup):
  font wiring and adherence-lint were already in the gate; fixed the remaining stale-doc cleanup
  (`packages/ui/README.md` no longer says `.jsx`)
- [x] 20.1 **Clerk integration**
  - [x] Install `@clerk/nextjs` + `svix` (+ `@clerk/testing` dev); `getAuthEnv()` in `env.ts`
    following the optional-secret pattern; `proxy.ts` middleware protecting account/admin routes only
    (anonymous upload/report flows must keep working with zero auth friction)
  - [x] Sign-in/sign-up routes styled with `@heimdall/ui` tokens (dark instrument panel, no stock Clerk look)
  - [x] User provisioning: JIT upsert into `users` on first authed request **and** Clerk webhook
    (`user.created`/`user.updated`/`user.deleted`) with **signature verification**; webhook is the
    sole trigger for the §20.4 erasure cascade (`lib/repo/erasure.ts` — `enqueueUserErasure()`
    already wired here; the remaining §20.4 work is the in-app delete route, privacy page, and the
    zero-DB-rows/zero-R2-keys integration test, now complete with a durable bounded maintenance worker)
  - [x] Session context available to API routes (`lib/api/auth.ts`: `getViewer`/`requireViewer`/
    `requireAdmin`); ownership checks in individual routes land with §20.2
- [x] 20.2 **Run ownership & management**
  - [x] Attach `user_id` at ingest when signed in (`ownerId` on the `Run`, set from `getViewer()`
    at `POST /api/runs`); anonymous default stays `unlisted`; `private` requires a viewer (400
    `auth-required-for-private` otherwise) and is fixed at create — finalize re-asserts ownership
    but never assigns it, an ownerless run can't finalize as private (claim is the only path)
  - [x] Unlocked true `private`: the single gate `isVisibleTo(run, viewer)` in `lib/repo/runs.ts`
    (private → owner-only; `flagged` → owner-visible; `hidden` → invisible to everyone including
    the owner); threaded through `readVisibleRun`/`readVisibleFramesState`/the `/runs/[id]` page.
    `readVisibleBenchmarkSet` takes a `viewer` param for API symmetry but deliberately does NOT
    relax `isAggregateEligible` for it yet — see its docstring for why that's a deferred product
    decision, not an oversight. Aggregates untouched (still `aggregateEligibilitySql`, public-only)
  - [x] Per-run visibility switcher — `PATCH /api/runs/:id`, owner-only (404 for anyone else)
  - [x] **Claim flow** — `POST /api/runs/:id/claim`: signed-in + Bearer management token, one
    atomic conditional UPDATE (ownerless + hash still matches), single-use (clears the hash)
  - [x] Account page (`/account`): identity card (Clerk name/avatar + our `role`/email), "My runs"
    list with visibility select + delete, matching the design kit. Handle-editing UI intentionally
    deferred — `PATCH /api/account` + `isValidHandle` are built and tested, just not wired to a
    form yet
  - [x] Owner authorization added to `DELETE`/`PATCH /api/runs/:id` (owner OR anonymous token OR
    admin for delete; owner-only for the visibility switch). No user-facing `reprocess` route
    exists (CLI/cron-only) — N/A, not a gap
  - [x] Per-user rate limits: `requireRateLimit` keys `user:{id}` (multiplier via
    `RATE_LIMIT_AUTHED_MULTIPLIER`) else `ip:{ip}` (now preferring `cf-connecting-ip`); wired at
    create/finalize/delete/claim/search/distribution
  - Found and fixed along the way: (1) wrong Clerk appearance variable names (this major version
    renamed `colorInputBackground`→`colorInput` etc.) and an unstyled `badge` element — both caught
    by rendering the real sign-in modal; (2) `auth.protect()` was redirecting to Clerk's *hosted*
    account-portal sign-in instead of our own `/sign-in` — fixed via `NEXT_PUBLIC_CLERK_SIGN_IN_URL`
    / `_SIGN_UP_URL` env vars; (3) a test-mock footgun where a hoisted mock's pre-`setViewer()`
    default returned bare `null` instead of a 401 `NextResponse`, crashing (not failing) any test
    that checked anonymous-401 behavior first — fixed with `beforeEach` normalization
- [x] 20.3 **Verified-reviewer tier** (the trust anchor for public averages — README feature)
  - [x] Admin grant flow (`lib/repo/verifications.ts` + `POST`/`DELETE /api/admin/verifications`,
    admin-only) writing `verifications` (`hardware_vetted`, `granted_at`, `verified_by`) AND
    `users.role='verified'` atomically; grant/revoke are no-ops against an existing admin (role is
    one enum, not independent flags — never demotes an admin to `public`/`verified`)
  - [x] `shield-check` badge on game submissions (`u.role` added to the `games.ts` join) and the
    account identity card (already read `user.role` there from §20.2). Run-page badge skipped
    deliberately — see the "not done" note below
  - [x] `verifiedOnly` activated in `lib/repo/distribution.ts` (was accepted-but-inert since Phase
    7): an additive `exists (... u.role = 'verified')` fragment appended to the existing filter
    clauses, never a forked copy of `aggregateEligibilitySql`/`cohortEligibilitySql`. Filter/marker
    only, math untouched — same query, fewer rows in. UI: activated the previously-disabled
    "Verified only" `Switch` in `DistributionSection`
  - **Not done, deliberately**: no shield badge on the individual run page itself. While auditing
    this I found `runResponseSchema`/`Run.ownerId` was already a stubbed field from pre-Phase-8
    groundwork, silently `undefined` until this phase started writing real values into it — and
    `GET /api/runs/:id` was passing the full internal `Run` straight through as the HTTP response,
    which meant a raw Clerk user id was about to start leaking to any viewer of a public run. Fixed
    now: `runResponseSchema` no longer declares `ownerId`, and both the API route and the
    `/runs/[id]` server component strip it (`.parse()` / destructure-omit) before it reaches a
    client. A regression test asserts the API response never carries `ownerId`. A future run-page
    verified badge should read from a small dedicated field (e.g. `submitterVerified: boolean`),
    never from the owner id itself.
- [x] 20.4 **Deletion, erasure & privacy**
  - [x] Run delete (owner or token-holder) removes the Postgres row **and the R2 objects** — landed
    with §20.2's `DELETE /api/runs/:id`; `lib/repo/erasure.test.ts` proves no orphaned R2 keys for
    the account-cascade path
  - [x] Account deletion: `POST /api/account/delete` (in-app, auth-gated) asks Clerk to delete the
    user; the `user.deleted` webhook (already wired in §20.1) is the SOLE trigger that actually runs
    `enqueueUserErasure()` — this route never calls the cascade directly, so there is exactly one erasure
    path to reason about. `AccountClient`'s "Delete account" card added with an explicit
    type-to-confirm-adjacent step (danger button → inline warning + confirm/cancel, not a bare click)
  - [x] `/privacy` page: hardware snapshot named as collected quasi-identifying data, account data,
    hashed-token posture, visibility model, run/account deletion, signing-is-tamper-evidence-only,
    encryption — mirrors `docs/integrity-and-privacy.md`; extends again in Phase 12
  - Found and fixed along the way: a hydration mismatch in `AccountClient.tsx` —
    `new Date(...).toLocaleDateString()` reads the runtime's locale, which differs between
    server-render and the browser, and Next surfaced it as a "Recoverable Error" in the dev
    overlay on first real-browser load. Fixed with the same deterministic `Intl.DateTimeFormat("en",
    { dateStyle: "medium", timeZone: "UTC" })` pattern `SubmissionsTable.tsx` already used
  - Verified live (real browser, real Postgres, real Clerk session): uploaded a run, flipped its
    visibility public→private via the account page, confirmed the DB row updated; deleted a run
    from the account page and confirmed the row count and Postgres state both dropped. Did NOT
    click through the real "Delete account" confirm (irreversible against the live Clerk instance) —
    covered instead by `api/account/delete/api.test.ts` mocking the Clerk call
- [x] 20.5 **Moderation**
  - [x] Migration `0034_run_moderation_status.sql`: added `moderated` to the runs status CHECK,
    mirrored in `RUN_STATUS`/`runStatusSchema`. `isVisibleTo` treats it exactly like `flagged`
    (owner-visible, stranger 404s); aggregate guard needed no change (only `validated` pools).
    Also hardened `applyVerificationResult` (jobs.ts) and all three `applyReprocessResult`/
    `applyDriverRefresh` write-guards (reprocess.ts) to exclude `moderated` alongside `hidden` — a
    background verification/reprocess job completing after a moderator's takedown must not
    silently flip the run back to validated/flagged
  - [x] Migration `0035_reports.sql` (polymorphic run/game subject, `reporter_user_id` nullable +
    `on delete set null` so a report survives account deletion as audit history) + anonymous-
    allowed `POST /api/reports` (rate scope `create-report`) + `ReportButton` (reason + optional
    detail, shared component) wired into both `RunHeader` and `GameHeader`
  - [x] Admin queue at `/admin` (gated by `proxy.ts` sign-in + a role check in the page itself;
    every admin API call is independently gated by `requireAdmin`): list open reports, dismiss
    (`PATCH /api/admin/reports/:id`), hide the reported run (`POST /api/admin/runs/:id/moderate` —
    sets `moderated` AND resolves the run's open reports atomically, since hiding the content IS
    the resolution), plus the verified-reviewer grant form and single-game rename
    (`PATCH /api/admin/games/:id`). Cross-id game rename-**merge** deferred, as planned
  - Verified live: `curl` POST to `/api/reports` against a real uploaded run succeeded (201,
    correct `subjectRunId`/`status: open`); `/admin` and `GET /api/admin/reports` both correctly
    reject/redirect an anonymous caller
- **Verify**: anonymous upload → report flow still works end-to-end with no login wall; a
  logged-out stranger gets 404 on a private run; delete removes R2 objects; claim flow attaches an
  anonymous run; verified badge renders
- **Regression**:
  - [x] Dedicated authz matrix test (`apps/web/src/app/api/authz-matrix.test.ts`): every
    Clerk-viewer-gated mutating route × {anonymous, owner, non-owner, admin} in one file, status
    codes only (business logic stays in each route's own deeper `api.test.ts`). 12/12 passing
    against real Postgres on first run. `internal/jobs/drain` (bearer-token auth) and
    `webhooks/clerk` (Svix-signature auth) are intentionally excluded — neither uses the Clerk
    viewer, so neither fits this matrix; both already have their own dedicated auth tests
  - [x] `private` run: direct GET 404s for non-owner (verified live: `curl` with no session cookie
    → 404, on both the run page and `/api/runs/:id`, against a real uploaded private run); absent
    from search/game/distribution queries (unchanged — those never gained a viewer param)
  - [x] Aggregate eligibility unchanged: only `public` + `validated` pool (379/382 web tests passing
    against real Postgres, `aggregateEligibilitySql` untouched)
  - [x] Claim: used management token no longer deletes (explicit assertion added — an anonymous
    DELETE attempt with the now-cleared token 404s and the row survives) and the run shows in "My
    runs" (`listRunsForUser` includes it post-claim)
  - [x] Erasure: `lib/repo/erasure.test.ts` proves deleting a user leaves zero rows in
    `runs`/`verifications` and zero surviving R2 keys (mocked R2 client, real Postgres); the
    account-facing trigger (`POST /api/account/delete` → Clerk → `user.deleted` webhook →
    `enqueueUserErasure()` → bounded maintenance drain) is covered end-to-end by mocking each hop in its own layer's tests
  - [x] Webhook: `api/webhooks/clerk/api.test.ts` asserts a bad signature 400s and provisions
    nothing (real `svix` signing, not mocked)
  - [x] Playwright e2e (`e2e/account.spec.ts`) — **written and passing** once Docker became
    available in this environment. Real Clerk dev instance (ticket-based sign-in via
    `@clerk/testing`'s `clerk.signIn({ emailAddress })`, requiring `@clerk/backend`'s
    `createClerkClient` added as an explicit devDependency — `@clerk/nextjs/server`'s `clerkClient()`
    needs Next's request-context and can't be called from a standalone Playwright script); a
    disposable per-run Clerk user created in `beforeAll`/deleted in `afterAll` (verified: zero
    orphaned test users left behind); real R2 (not mocked — this is the one spec that exercises the
    live upload → finalize → verify-worker → visibility-toggle → game-page pipeline for a signed-in
    owner). Skips cleanly via `test.skip(!CLERK_CONFIGURED, ...)` when `CLERK_SECRET_KEY` is unset.
    3/3 consecutive runs green after the fix below
  - **Found and fixed while turning Docker on**: `run.spec.ts`, `game.spec.ts`, and `upload.spec.ts`
    were silently invisible to Playwright's test-file glob — `--list` showed only 2 of 5 spec files.
    Root cause: those three files were NTFS reparse points (Windows placeholder/virtualized-filesystem
    entries, empty `Target`) left over from however this sandbox's initial checkout was provisioned —
    `bash`/`Read`/`tsc` transparently resolve them, but Playwright's glob-based discovery does not
    follow reparse points, and it fails **silently** (no error, just "0 tests"), while
    `global-setup.ts`'s DIRECT path import of an equally-reparse-pointed file worked fine (Node's
    module resolution *does* follow them). Fixed by materializing all three as regular files
    (copy → delete original → rename; verified byte-identical to the git blob via `git diff`, zero
    content change). Also found: `game.spec.ts`'s search-to-navigate test is flaky specifically under
    parallel execution alongside the new (heavy: real Clerk + real R2) `account.spec.ts` — confirmed
    by 3/3 passes in isolation and 18/18 + 22/22 passes at `--workers=1`; not a functional regression,
    a resource-contention artifact on this machine. Regenerated the `home.spec.ts` visual baseline
    (flagged earlier this session as needing Docker) — now committed and green

### Phase 8 Regression Gate
- `pnpm verify` exits 0, **and** the full Playwright suite is green: 22/22 e2e tests (serial —
  `--workers=1` avoids the parallel resource-contention flake noted above), including the
  regenerated `home.png` visual baseline and the new `account.spec.ts`; migrations reentrant
  (`0034`/`0035` verified: applied cleanly, re-running `pnpm migrate` reports "already up to date")
- Authz matrix fully asserted (12/12); anonymous flows unchanged (confirmed: anonymous
  create/finalize/report all still succeed — see the matrix's "anonymous-allowed by design" rows)
- **Phase 8 is complete — every checklist item shipped, tested, and verified.** Ready for the
  Phase 8.5 security review
- **Still untested against real Clerk infrastructure:** a real end-to-end webhook delivery through
  an actual public tunnel (ngrok or similar) — today's webhook coverage signs payloads with the
  real `svix` library directly in-process, which proves the route's verification logic but has
  never received a request from Clerk's real servers

---

## Phase 8.5: Comprehensive Security Review

> Auth just landed — review the **whole surface** before building the desktop client on top of it.
> Run the `/security-review` skill against the branch, then work this checklist. Findings become
> issues; each fix lands with a regression test. Nothing ships to Phase 9 with an open High.

- [x] 8.5.1 **AuthN/AuthZ:** every route re-audited against the Phase 8 authz matrix; IDOR probes
  on run ids / management tokens / claim flow; Clerk session handling; admin routes locked
- [x] 8.5.2 **Tokens & secrets:** management-token hashing + constant-time compare still hold;
  `INTERNAL_JOBS_TOKEN` (drain route) rotation documented; no secret reaches the client bundle;
  logs redact tokens/keys
- [x] 8.5.3 **R2 / upload path:** presigned PUT scope (key, content-length, expiry); nonce'd keys
  unguessable; `exports/` prefix still write-locked pre-Phase 11; upload limits (`§11.10`) enforced
  **before** a presigned URL is issued; Parquet parsing treated as hostile input
- [x] 8.5.4 **Injection & parsing:** SQL parameterization sweep (repos + migrations helpers);
  hostile CSV/JSON parser fuzz (extend `malformed/*`); no user string reaches HTML unescaped;
  abusive game-name path (moderation) covered
- [x] 8.5.5 **SSRF / egress:** `apps/driver-curation` fetchers pinned to allowlisted vendor hosts;
  redirects and content-type validated; timeouts + size caps
- [x] 8.5.6 **Platform:** security headers (CSP, HSTS, frame-ancestors, referrer-policy) on the
  web app; Cloudflare in front of production (WAF, bot mitigation) — part of the deploy env work;
  Neon + R2 at-rest encryption verified still on (`§1.5` guardrail)
  — application-boundary headers shipped in `next.config.ts` and verified; the Cloudflare
  WAF/bot-mitigation and provider at-rest-encryption toggles are deployment-environment items,
  tracked in the deploy checklist below (not code-verifiable from this repo)
- [x] 8.5.7 **DoS & abuse:** rate limits (per-IP + per-user) on create/finalize/delete/search/claim;
  drain endpoint auth; reprocess sweeps bounded (already) — confirm under adversarial input
- [x] 8.5.8 **Supply chain:** `pnpm audit:deps` clean at moderate+; `check:deps` policy exceptions
  reviewed (wrangler exception still justified?); lockfile integrity in CI
- [x] 8.5.9 **Privacy:** erasure cascade proven (DB + R2); hardware-fingerprint handling matches
  the privacy policy; no quasi-identifying data in logs/analytics
- [x] 8.5.10 Fix all findings (severity-ordered), each with a regression test; document accepted
  risks in `docs/integrity-and-privacy.md` — no High/Critical/Medium code findings surfaced, so
  no fixes and no newly accepted risks
- **Verify**: `/security-review` re-run reports no High/Critical; authz matrix green
- **Regression**: every fixed finding has a test that fails on revert

### Phase 8.5 Regression Gate
- Zero open High/Critical findings; accepted risks documented; `pnpm verify` green

**Phase 8.5 complete (audited 2026-07-22).** Whole-surface review (auth seam, IDOR/visibility
gate, anonymous management tokens, R2 presign scope, SQL parameterization, Clerk webhook
verification, admin routes, driver-curation SSRF, security headers) found **no High/Critical/Medium
vulnerabilities**. All SQL `${…}` interpolations are internal enum constants, never user input; no
`dangerouslySetInnerHTML` anywhere; `isVisibleTo` correctly gates private/flagged/moderated/hidden.
Gates: `pnpm verify` exit 0, `pnpm audit:deps` clean (a transient `sharp` advisory glitch cleared on
re-run — installed 0.35.0 is the patched line), `pnpm check:deps` passed. Deploy-env items in 8.5.6
(Cloudflare WAF, provider at-rest encryption) remain in the deploy checklist below.

---

## Phase 8.6: Run/Game Page Data Completeness (UI catch-up)

> Audited 2026-07-20 during Phase 8 manual testing: a lot of Phase 3–7.5 backend work — capability
> manifest, the full declared methodology profile, diagnostic evidence detail — is computed and
> stored but never rendered anywhere a user can see it. This phase closes that gap. No new backend
> work; every field here already exists in `packages/shared/src/types.ts` and is already flowing
> through the API. Visual target: extend the existing `RunPage.jsx`/`GamePage.jsx` kits (several of
> these — the settings-string subtitle, the verified shield badge — are already drawn in the kit
> and simply never got built).

- [x] 8.6.1 **Capability manifest panel** (run page): `sensors` coverage, `presentationMode`,
  `syncMode`, `frameGenerationObserved`, `vramCapacity`, `caveats` — none of `capabilityManifest`
  is currently displayed. For `cpuBusyMs`/`gpuBusyMs`, make the bottleneck-data readiness explicit:
  show present/absent, frame-aligned/not safe for attribution, and the HAGS qualification when it
  applies — `CapabilityCard.tsx` + shared `sensor-labels.ts`; renders nothing (no placeholder) for
  manifest-less runs
- [x] 8.6.2 **Declared methodology, shown not just validated**: `RunHeader` subtitle should read
  the settings string per the kit ("Ultra · Ray Tracing: Overdrive · 1440p · DX12 · 62s capture");
  currently `methodologyManifest` is only read to name *missing* fields (`IncompleteProfileCard`),
  never to display the *declared* ones. Also missing on submission rows: `settingsPreset`, `scene`,
  frame-pacing (`capFps`/`vsync`/`vrr`/`refreshHz`), `gameBuild`, `captureTool`, `warmupPolicy`,
  `hags` — today split inconsistently between per-row and cohort-bucket display, several nowhere.
  NOTE: the per-row fields required widening `GameSubmissionMethodology` (shared type + zod +
  `mapSubmission` projection from the already-selected `settings_json`) — no SQL/migration change,
  so the phase's "no new backend work" premise survived in spirit. The kit's named RT tier
  ("Ray Tracing: Overdrive") is unrepresentable (domain model is off/on/unknown) — subtitle says
  "Ray tracing"; resolution renders raw ("2560x1440"), no lossy "1440p" prettifier
- [x] 8.6.3 **This run's own** `frameTimeP95Ms`/`frameTimeP99Ms`/`stutterCount` as stat tiles —
  currently these are only distribution-metric *options* on the game page, never shown as the
  run's own numbers
- [x] 8.6.4 **Diagnostic evidence detail**: `DiagnosticEvidence.coverageFraction`, `sensors[]`,
  `metrics{}` (bottleneck-attribution percentages), `caveats[]`, and
  `provenance.{sourceUrl,referencedVersion,fetchedAt}` (the driver-update source link) are computed
  server-side and dropped before the card renders. For busy-time attribution, render human labels
  (not raw metric keys) for paired-frame coverage, paired sample count, CPU-bound/GPU-bound/
  cap-or-display-limited fractions, confidence, and HAGS caveats — `DiagnosticEvidenceDetail.tsx`
  behind a native `<details>`; label map drift-guarded against
  `DIAGNOSTIC_EVIDENCE_METRIC_KEYS`, which `packages/shared/src/constants.ts` owns (the contract's
  vocabulary belongs with the schema, not with the attribution engine that happens to emit it)
- [x] 8.6.5 **Hardware snapshot**: add `gpuVramTotalMb` (capacity, not just peak used) — peak VRAM
  becomes a meter only when the capacity was declared; plain row otherwise. `gpuVendor` was
  deliberately NOT given a row: the `gpu` string already leads with the vendor ("NVIDIA GeForce
  RTX 4080"), so a separate row restates it, and the design kit's hardware card has none. The field
  still drives the sensor-availability matrix upstream — it is unrendered, not unused.
- [x] 8.6.6 **`RunSummary.sampleCount`** as a visible number, not just a tooltip title on the
  confidence badge — "Graded from N frames" caption under the smoothness tiers
- [x] 8.6.7 Depends on **§20.3 (verified-reviewer tier)** landing first: the shield-check badge on
  `SubmissionsTable` rows (drawn in `GamePage.jsx`, no placeholder in the component yet) and
  activating the already-present disabled "Verified only" `Switch` in `DistributionSection` —
  premise was stale: both halves already shipped with §20.3 (badge at SubmissionsTable, Switch
  fully wired, never disabled). Closed by adding the missing switch-refetch regression test
- [x] 8.6.8 **Busy-time timeline** (run page): when paired, frame-aligned `cpuBusyMs` and
  `gpuBusyMs` telemetry is available, offer a CPU Busy / GPU Busy / frame-time chart overlay;
  otherwise state why attribution and the overlay are unavailable. Never render missing samples as
  zero; retain the HAGS qualification. This extends the front-end Parquet chart projection only —
  no new server-side data model or API work — chart projection widened to 6 columns, `FrameSeries`
  carries NaN-holed busy arrays, downsampler emits explicit gap points, overlay is ms-only
  (busy time is a duration) and gated on the capability manifest with named unavailable reasons
- **Verify**: run page and game page visually match the current `design/ui_kits/web/**` kit;
  nothing in `packages/shared/src/types.ts`'s domain model is silently dropped between API response
  and rendered DOM (spot-check by diffing a real API response against what's on screen)
- **Regression**: component tests asserting each newly-wired field renders from a fixture with that
  field populated

### Phase 8.6 Regression Gate
- Full domain model has a UI home; `pnpm verify` green; visual baselines updated deliberately (not
  casually) to match

**Phase 8.6 implemented (2026-07-22).** Kit-first: RunPage/GamePage kits extended (capability
panel, 7-tile row, evidence disclosure, sample-count caption, busy-time overlay + legend/captions,
Methodology column with declared line + profile tooltip) before the production build. New chart
tokens `--chart-cpu-busy`/`--chart-gpu-busy`. API-vs-DOM spot-check of `runResponseSchema`:
every field now has a UI home except deliberate exclusions — `ownerId` (stripped at the wire,
§20.3), `canonicalGpuId`/`canonicalCpuId` (internal linkage), `schemaVersion`/`parserVersion`/
`framesObjectKey` (internal provenance/plumbing), `signatureValid` (deferred to Phase 9 — browser
uploads carry no signatures, so showing "unsigned" on every run would mislead; **shipped in Phase 9
as §22.8**, rendered only when a signature was actually checked), and
`summary.frameTimeP50Ms` (functional home: the client stutter threshold). Gates: `pnpm verify`
exit 0; functional e2e green (20/20).

**CSP fix found via `account.spec.ts` (2026-07-22).** That spec's sign-in timeout was not an
external Clerk outage — the §8.5.6 CSP listed Clerk in `connect-src`/`frame-src` but not
`script-src`, so the browser blocked `clerk.browser.js`, the SDK never booted, and every auth
surface failed to hydrate under the policy (production included, not just e2e). Fixed by hoisting
the host list to a shared `CLERK_HOSTS` in `next.config.ts` and granting it in `script-src` too;
pinned by `src/lib/security-headers.test.ts`. **Note for deploy:** a Clerk *production* instance on
a custom domain (`clerk.<yourdomain>`) matches none of the current patterns — that host must be
added before going live, or this bug returns. **Outstanding:** `@visual`
baselines (`run-page.png`, `game-page.png`) must be regenerated ONCE on CI ubuntu in a dedicated
commit — local Windows renders are not valid baselines.

---

## Phase 8.7: Steam Ingest — the game-context dimension

> Started 2026-09-02. `games` is a five-column hand-seeded dictionary, which is the staleness
> treadmill `docs/driver-currency-curation.md` names ("the failure mode that rotted
> FlightlessMango"). Phase 6.6 fixed that for drivers and left it unfixed for games. This phase is
> the scheduled equivalent, reusing the `apps/driver-curation` shape: a Cloudflare Worker on cron
> writing to Neon through `@neondatabase/serverless`.
>
> **The reason this phase exists is `steam_app_updates`, not the time series.** A run carries a
> `captured_at`; an update carries a `posted_at`; joining them is what lets §25–§26 say "this title
> patched between your two runs" instead of reporting an unexplained 6 FPS delta. No other
> benchmark tool holds both halves. Player counts, prices and review trajectories are cheap to
> collect alongside it and worth having, but they are context, not the reason.
>
> **Started before the UI exists on purpose.** Historical data is the one input that cannot be
> backfilled later; every day of delay is a day of history this project will never have from its
> own source. Nothing here is on the run-ingest hot path, and every consumer must tolerate all of
> it being absent.

- [x] 8.7.1 **Migration `0041_steam_ingest.sql`** — `steam_apps` (catalog + `poll_tier` cadence
  control), `steam_player_counts`, `steam_review_snapshots`, `steam_price_snapshots`,
  `steam_app_updates`, `steam_app_tags`, `steam_raw_snapshots`, `steam_app_changes`, and a nullable
  `games.steam_appid` link (unique partial index, `on delete set null`). Every time-series key is
  `(appid, bucket)` where `bucket` is the poll time floored to the lane cadence — a retried cron,
  an overlapping invocation and a double deploy all collapse onto one row.
- [x] 8.7.2 **`apps/steam-ingest` Worker**, four cron-dispatched lanes: players (10 min), reviews
  (hourly), prices (4x daily), catalog (daily). `CRON_LANES` in `src/index.ts` maps each
  expression; an unmapped cron logs rather than failing silently.
- [x] 8.7.3 **Allowlisted fetch** (`api.steampowered.com`, `store.steampowered.com` only, redirects
  revalidated, body cap, timeout) mirroring `driver-curation/src/fetch.ts`, plus a
  bounded-concurrency mapper so one dead app cannot discard a batch and no invocation blows the
  Worker subrequest budget.
- [x] 8.7.4 **Every source is keyless.** Verified live 2026-09-02: `GetNumberOfCurrentPlayers`
  (47 B), `appreviews?num_per_page=0` (199 B), `appdetails?filters=price_overview` (batches ~50
  appids per subrequest), `appdetails`, `ISteamNews/GetNewsForApp` (tags items `patchnotes`), and
  `featuredcategories` for discovery. `STEAM_API_KEY` is documented in `.env.example` but is
  needed only for `IStoreService/GetAppList` bulk enumeration — see 8.7.8.
- [x] 8.7.5 **Content-addressed raw retention.** `steam_raw_snapshots` is keyed
  `(appid, source, payload_hash)`, so a year of byte-identical daily reads costs ONE row and only
  advances `last_seen_at`, while a real change writes a new row. Storing every daily body instead
  would be ~35 KB x apps x 365. Every unmodelled field (metacritic, platforms, dlc, packages,
  requirement blobs) stays recoverable without a migration.
- [x] 8.7.6 **Field-level change history** computed in the same statement as the metadata upsert:
  a `prior` CTE reads the pre-update snapshot, so the diff cannot race a concurrent writer. A first
  observation is not a change (no prior read), and a staler read never overwrites a fresher one.
- [x] 8.7.7 **Self-suppressing everywhere.** A tag that vanishes upstream keeps its row with a
  stale `last_seen_at` rather than being deleted; `is_patchnote` false means "no evidence", never
  "not a patch", and is latched so a re-read cannot un-flag it; a null player count (most DLC and
  tools) is a normal answer, not an error.

### Explicitly NOT delivered by this phase — do not imply otherwise
- **Engine and technology detection.** SteamDB infers "Unity"/"Unreal" from depot FILE LISTS. That
  is depot access via the Steam network (SteamKit2 + PICS), not the Web API. `games.engine` stays
  hand-curated.
- **Build/depot/manifest change history.** SteamDB's change history is the PICS changelist stream.
  `steam_app_changes` holds changes to the store metadata we observe, which is a strictly smaller
  and honestly different thing. `steam_app_updates` (announcements) is the patch signal available
  without PICS, and is the one §25–§26 actually needs.
- **Community tags.** `steam_app_tags` carries genres and store categories from `appdetails`. The
  user tags SteamDB shows are in the store page HTML, not any JSON endpoint — hence the `kind`
  discriminator, which already reserves `'tag'`.
- **Historical backfill.** The series starts 2026-09-02. There is no way to buy the missing years,
  and SteamDB explicitly prohibits crawling, so this is a floor, not a gap to close.

- [ ] 8.7.8 **Bulk catalog seed** using `STEAM_API_KEY` + `IStoreService/GetAppList` (403s without a
  key; `ISteamApps/GetAppList` was REMOVED upstream — confirmed 404 "Method 'GetAppList' not found
  in interface 'ISteamApps'" on 2026-09-02). Today's working set grows only from
  `featuredcategories` (~56 appids/day). Until this lands, coverage is thin but real.
- [ ] 8.7.9 **Wire `games.steam_appid`** — resolve existing canonical games to appids, so the run
  corpus can join the update history. Reuse the conservative token-overlap matcher from
  `driver-curation/src/db.ts` rather than inventing a second one.
- [ ] 8.7.10 **Patch-annotated deltas** — the §25–§26 payoff: annotate a before/after comparison
  with the updates that landed between the two captures.
- [ ] 8.7.11 **Move the time series to ClickHouse (§28/Phase 12).** 400 apps at 10 min is ~57k
  rows/day; the shapes here are deliberately narrow and additive so the copy is mechanical.

- **Verify**: `pnpm --filter @heimdall/steam-ingest test` green including the real-Postgres suite;
  `deploy:dry-run` clean; after deploy, confirm rows accumulate in `steam_player_counts` across two
  consecutive cadence windows and that a re-run inside one window adds none.
- **Regression**: unit suites for fetch allowlist/concurrency, every source parser against captured
  fixtures, statement shape and row mapping; a real-Postgres suite covering migration shape,
  per-bucket idempotency, the unknown-appid guard, change-log correctness, raw dedup, the
  patch-note latch, and the `games` link constraints.

### Phase 8.7 Regression Gate
- `pnpm verify` green; 83 tests in `apps/steam-ingest` (15 of them against Postgres 17); the worker
  builds under `wrangler deploy --dry-run`; no lane can exceed its per-invocation subrequest cap.

**Phase 8.7 collectors implemented (2026-09-02).** Schema, worker and all four lanes landed with
fixtures captured live the same day. 8.7.8-8.7.11 are open. **Deploy needs:** `DATABASE_URL` as a
Worker secret, `pnpm migrate` against Neon, and a Workers PAID plan — `LANE_LIMITS` defaults assume
the 1000-subrequest budget; the free plan's 50 requires dropping every cap by an order of
magnitude, and the honest fix there is a smaller working set, not a higher cap.

---

## Phase 8.8: Build Identity — PICS changelists and local build pinning

> Phase 8.7 deliberately stopped at store metadata. The thing it cannot reach is **build identity**:
> which BUILD of a game a run was captured on. `steam_app_updates` (announcements) tells you a patch
> was announced; a buildid tells you exactly what the player was running. For a benchmarking project
> that is the difference between "something changed around then" and "these two runs are not
> comparable, and here is the build that separates them".
>
> This is the SteamDB capability people actually mean by "change history" — the PICS changelist
> stream over depots, manifests and build ids. It is NOT in the Web API and cannot be added to the
> 8.7 worker: PICS needs a persistent authenticated connection to Steam's CM servers, which is a
> long-lived process, not a cron-triggered Worker invocation.
>
> **The cheap half does not need PICS at all.** Steam writes
> `steamapps/appmanifest_<appid>.acf` on the player's own disk, and it contains `buildid` for the
> installed build. The desktop client is already on that machine at capture time.

### 8.8a — Local build pinning (no PICS, no new infrastructure)
- [x] 8.8a.1 Desktop client reads `buildid` (and the branch) from `appmanifest_<appid>.acf` in the
  library folder that holds the captured game; resolve the library via `libraryfolders.vdf`. Pure
  file parsing in the Rust half, so both platform runners test it.
- [x] 8.8a.2 Carry it through the §11 ingest contract onto `runs`, alongside the existing
  `gameBuild` methodology field — which is today a free-text user claim, not an observed fact.
  Keep them distinct: one is declared, one is observed. Never overwrite the declaration.
- [x] 8.8a.3 Comparability: two runs on different buildids of the same title are a named,
  displayable reason a delta may not be like-for-like. Follow the existing rule —
  `packages/shared/src/comparability.ts` owns this predicate, and nothing re-derives it.
- **Why this first:** it is strictly local, needs no new deployment target, and delivers the exact
  fact §25-§26 wants. It self-suppresses cleanly: a non-Steam game or an unreadable library folder
  yields null, and null must never degrade a run.

**Phase 8.8a implemented (2026-09-03).** `apps/desktop/src-tauri/src/steam.rs` — a
small real VDF tokenizer (both Steam files are VDF, and `installdir` values contain
spaces while Windows paths are backslash-escaped, so a regex was not viable),
`libraryfolders.vdf` -> every library root, `appmanifest_<appid>.acf` -> appid, name,
installdir, buildid and opted-in BetaKey.

**Matching is PATH CONTAINMENT only, never a name guess.** The executable is resolved
from the pid (`QueryFullProcessImageNameW` on Windows, `/proc/<pid>/exe` elsewhere)
and matched against `<library>/steamapps/common/<installdir>` segment-wise — a plain
string prefix would match "Portal 2 Demo" against "Portal 2", which a regression test
pins. A wrong buildid is far worse than a missing one.

**No migration.** `settings_json` has held the whole methodology manifest since 0017,
which is explicit that only QUERYABLE comparability-key fields earn a column. The
observed fields (`steamAppId`, `steamBuildId`, `steamBranch`) ride along; `gameBuild`
stays the uploader's declared free-text claim and is never overwritten by an
observation.

**8.8a.3 is deliberately NOT a comparability key field.** Adding the buildid to
`KEY_FIELDS` would give every title fresh buckets on every patch, and since outlier
rejection and the bell curves are inert below the cold-start threshold (§17.4/§18.2),
most distributions would silently stop rendering on patch day. Pooling ACROSS builds
is what lets a distribution exist. `buildIdentityRelation` therefore returns a named
reason for §25–§26 to display beside a delta, and a test asserts the key does not
contain it.

**Explicitly not delivered:** Linux build pinning. The MangoHud watcher reports pid 0
— it sees a log file, not a process (§23.1) — so there is nothing to resolve an
install from and the field is absent there. The PARSING is pure and both CI runners
test it; only the resolver has no Linux caller, hence the `cfg_attr` dead-code guard.
macOS is untouched.

### 8.8b — PICS collector (~~new deployment target~~ NO new infrastructure)

> **The heading's premise was wrong and is kept here as the correction.** This was
> written assuming PICS needs a persistent connection, so it needs an always-on host,
> so it needs Fly.io/Railway/a VPS. Measuring it before building disproved that:
> anonymous login to a Steam CM completes in **587 ms**, and because every run does a
> full refresh (the changelist truncates silently), correctness never depended on
> staying connected. It is a GitHub Actions job with one secret.
- [x] 8.8b.1 ~~A long-lived process~~ **A scheduled job** subscribing to the PICS changelist stream and recording, per app:
  buildid per branch, depot list, and the changenumber/timestamp of each change. **Anonymous login
  is sufficient** for public appinfo — no Steam account credentials, so there is no credential to
  leak or get limited. Verify the exact client API surface before committing to a library:
  `steam-user` (Node, keeps the stack in TypeScript) or SteamKit2 (C#, the reference
  implementation).
- [x] 8.8b.2 Writes to the SAME Neon database as 8.7, into `steam_app_builds` (new) — not into
  `steam_app_changes`, which is honestly scoped to store-metadata diffs and should stay that way.
- [ ] 8.8b.3 Engine and technology detection, which is downstream of depot access rather than a
  separate feature: it is inferred from depot FILE LISTS (a `UnityPlayer.dll` in the manifest).
  Only worth doing once 8.8b.1 is running; would finally let `games.engine` stop being hand-curated.
- **Deployment reality:** this cannot run on Cloudflare Workers. It needs a small always-on
  container (Fly.io / Railway / a VPS). That is a second deployment target for the project, so it
  is a decision, not an implementation detail. 8.8a delivers most of the benchmarking value without
  it.

**Phase 8.8b implemented (2026-09-03).** `apps/steam-pics` + migration
`0042_steam_builds.sql`. Verified live before any code was written: anonymous login
returns public appinfo in **587 ms**, so this is a JOB, not a service — no VPS, no
container, no second deployment target. It runs hourly on GitHub Actions and needs
exactly one secret, `DATABASE_URL`; there is no Steam credential to store.

Two measured findings shaped the design, both worth keeping:
- **The changelist silently truncates.** `getProductChanges(cur - 500)` returns 381
  app changes; `cur - 20000` returns ZERO apps, with no error and no
  `forceFullUpdate`. A collector that followed the changelist alone would go blind
  after any gap. So every run refreshes the FULL tracked set and the changelist is
  provenance only — missing one costs nothing, because each branch carries its own
  `timeupdated`. That is also why cadence affects discovery latency but never
  timestamp accuracy.
- **Manifest gids overflow a JS number.** `6967806384656644903` becomes
  `6967806384656645000` through `Number()`. Gids are text end to end and cast by
  Postgres, never by the collector; a regression test pins it.

First production run: 184 apps -> 524 builds, 2026 depots, 9001 manifests, 0 failed
batches, cursor 38557998. Real patch history landed immediately (ARK: Survival
Ascended build 25089967 at 01:26Z).

**Still open:** 8.8a (local ACF `buildid` pinning in the desktop client) is the half
that makes a RUN comparable, and is untouched. 8.8b gives the catalog-side history
it will join against. Engine detection stays out of scope: it needs depot FILE
lists, which means downloading manifests, not just recording their gids —
`steam_app_depot_manifests` is the table that would make it possible later.

### Phase 8.8 Regression Gate
- ACF parsing covered by fixtures for both a normal library and a Flatpak/alternate library path;
  a missing or malformed manifest yields null and never fails a capture; `pnpm verify` green.

---

## Phase 9: Desktop Capture Client — Windows (Tauri 2 + PresentMon) — §21–§22

> The second product surface. Runbook: [`docs/desktop-client.md`](docs/desktop-client.md).
> Visual target: `design/ui_kits/desktop/CaptureClient.jsx` (onboarding → ready → capturing →
> complete, `§22.4`). The §11 ingest protocol was extracted to `packages/ingest-client` so the web
> hub and the desktop client speak it from one implementation.

- [x] 21.1 Tauri 2 scaffold in `apps/desktop` (Rust backend + web frontend using `@heimdall/ui`
  tokens); wire into pnpm workspace + CI (Tauri job now real)
- [x] 21.2 Bundle Intel PresentMon as a sidecar binary; license/attribution; version pinned and
  recorded in the capture provenance (`§2.2`)
- [x] 21.3 Global hotkey (default Shift+F11) start/stop; ~60 s guidance; tray presence
- [x] 22.1 Capture pipeline: spawn PresentMon against the foreground game process → stream CSV →
  parse with `@heimdall/parsers` (same code as web) → live frame count + trace during capture
- [x] 22.2 Hardware snapshot (GPU/driver/CPU/RAM speed + rated speed/OS/resolution, HAGS state) —
  **declared by the client**, per the `§8`/`§16a` contract in `packages/parsers` (columns.ts /
  presentmon.ts say these must come from the client, never inferred)
- [x] 22.3 Ed25519 payload signing (key in client; server records `signature_valid` via
  `HEIMDALL_SIGNING_PUBLIC_KEY`) — tamper-evidence only, per `§0.5`; never marketed as anti-cheat
- [x] 22.4 Four-state UI per the kit: Ready (hardware + hotkey) → Capturing (timer, live trace,
  frame count) → Complete (smoothness tiles, "payload signed" note, upload & share / discard)
- [x] 22.5 Upload through the existing ingest API (presigned Parquet PUT); signed-in via Clerk
  device flow or browser handoff; anonymous fallback keeps the management-token path
- [ ] 22.6 Real-capture fixture sweep — **needs a real game capture on owned hardware.**
  Scope was narrowed to AMD by decision; NVIDIA/Intel cells stay `synthetic` and are documented as
  open contributions in `packages/parsers/fixtures/README.md`.
  - The AMD PresentMon cell is ALREADY `verified-real` (`presentmon/v2-amd-real.csv`) for
    `CPUBusy`/`GPUBusy`, so the original "extend it with GPU telemetry" plan is **not achievable**:
    `GPUUtilization`/`GPUFrequency`/`GPUPower`/`GPUMemUsed` are not emitted by ANY PresentMon
    console CLI. Tested three ways on Windows 11 / RX 9070 XT — bundled 2.4.1 alone, 2.4.1 with
    Intel's full MSI installed and `PresentMonSharedService` running, and Intel's own 2.5.1 console
    CLI with the service running — identical header each time, and 2.5.1's `--help` has no telemetry
    switch. The columns belong to the PresentMon UI app, not the console tool, so shipping or
    recommending the full install would buy nothing. Recorded in `presentmon.rs`,
    `docs/desktop-client.md` and the fixtures README rather than left as a puzzle.
  - Frame generation turned out to be unreachable too, on AMD at least. `--track_frame_type` needs
    "application and/or driver instrumentation using Intel-PresentMon provider" (its own help), which
    AMD's driver does not emit: an RX 9070 XT running Cyberpunk 2077 with FSR AND frame generation
    enabled produced 14,241 rows, every one `Application`. Wanted-list item #9 now needs a title or
    driver that instruments for Intel's provider. Land the fixture + hand-computed `*.expected.json`
    via procedure 16a.1 when one is available.
- [x] 22.11 **Integrity gap: frame-generated runs are indistinguishable from genuine ones.** Because
  `generatedFramePct` recomputes to 0 (22.6), `reconcileGeneratedFrameTech` resolves such a run to
  `generatedFrameTech: none` — and a client declaration cannot override it, by design, since the
  recomputed percentage is treated as decisive. The Cyberpunk capture above averaged 244 FPS with
  frame generation on. If the driver inserts interpolated frames after present, that figure is an
  honest app-side rate; if they reach the swapchain, the run overstates real rendering by ~2x. The
  capture cannot tell us which — the frame-time distribution is unimodal. Either way such a run
  currently pools with genuine non-generated runs in comparability buckets (`frameGeneration` is a
  key field). Needs a decision: trust a declaration for this field, find a detectable signature, or
  state the limitation on the run page. Not a Phase 9 regression — it predates the desktop client and
  affects browser uploads equally — but the desktop client is the first thing that makes it common.
  - **MEASURED, and it is the bad case.** Same scene, same settings, frame generation the only
    variable, on an RX 9070 XT in Cyberpunk 2077:

    | | frames | duration | avg FPS | min frame time |
    |---|---|---|---|---|
    | FG on | 14,241 | 58.4 s | **243.9** | 0.32 ms |
    | FG off | 7,839 | 60.0 s | **130.7** | 3.11 ms |

    Ratio 1.87x. The interpolated frames ARE in the present stream: PresentMon counts them, labels
    every one `Application`, and the pipeline then records `generatedFrameTech: none`. So such a run
    reports ~244 FPS, pools with genuine 244 FPS runs, and has its 1% lows and stutter counts
    computed over interpolated frames.
  - Recommended fix, consistent with how this codebase treats every other unknowable: distinguish
    "the format reported zero generated frames" from "the format cannot report generated frames at
    all". `reconcileGeneratedFrameTech` currently derives `none` from a recomputed 0, which asserts
    absence from absence of evidence — the same mistake HAGS (`unknown` when the registry value is
    missing) and `ramRatedSpeedMtps` (omitted unless genuinely known) deliberately avoid. A capture
    with no frame-type column should resolve to `unknown`, not `none`. That is a semantics change to
    `@heimdall/shared` + the verify worker affecting existing rows, so it wants its own phase, not a
    tail-end edit to Phase 9.
  - Sub-millisecond presents (min 0.32 ms vs 3.11 ms) appear only with FG on and may be a usable
    detection signal, but one machine and one title is not enough to calibrate a rule on.
  - **Implementation path, and it is smaller than it looks.** `frame.generated` is only ever set to
    `true` (frames.ts) — never `false` — so a capture with no `FrameType` column and one whose every
    row reads `Application` both serialize to all-null. The evidence distinction is lost before the
    server sees it. But `generated` is ALREADY a nullable BOOLEAN in the v1 Parquet schema, so no
    migration is needed:
    1. Parser: write `generated: false` when the frame-type column exists and reads `Application`;
       leave it undefined only when the format carries no such column. Parser version bump.
    2. `reconcileGeneratedFrameTech`: let the recompute overrule a declaration only where it
       OBSERVED generated frames. A zero count is not evidence of absence.
    3. Collect frame generation in the desktop Run details form and on the web upload page.
    4. `none` is then only ever recorded because a human declared it; an undeclared run is
       `unknown`.
  - **The "did we look" bit does not exist, and the first attempt at this shipped a fix that did
    not fix the measured case.** The plan above originally routed the decision through "was any
    non-null `generated` value read". But the client passes `--track_frame_type`, so the AMD capture
    above HAS a `FrameType` column — 14,241 rows of `Application`. Column presence therefore read as
    evidence, the recompute overruled the uploader's `fsr3`, and the run went out as `none` again.
    An all-`Application` column is exactly what an uninstrumented driver produces, so it can never
    be distinguished from no column at all; only an observed `true` carries information. The rule
    now keys on that, and lives in `@heimdall/shared` because the client applied one copy at create
    and the verify worker another at finalize — they had already drifted (the client kept a declared
    `none` the server rewrote).
  - Consequence accepted: pre-existing rows carry a `none` that the OLD rule manufactured, and
    nothing in the data distinguishes it from a declared one, so a reprocess leaves it as `none`.
    Scrubbing those is a data decision (a targeted reprocess), not something the reconcile rule can
    infer.
  - Trusting the declaration here is not a departure. `upscaler`, `rayTracing`, `settingsPreset` and
    `scene` are already unverifiable client declarations AND comparability key fields.
    `frameGeneration` is the odd one out in being server-derived, and that special case is precisely
    what manufactures the false `none`.
  - **DONE** — `presentmon@1.2.0`. What this does and does not fix: the reported FPS of a
    frame-generated run is still inflated, because the interpolated frames really are in the present
    stream and nothing distinguishes them. What no longer happens is the pipeline MANUFACTURING the
    claim that a run was not frame-generated. A declared run keeps its declaration; an undeclared
    one carries `unknown`. A run whose uploader declares `none` while frame generation is on is
    still indistinguishable from an honest one — that needs §22.13, not a frame-type column.
  - [ ] Still open: making the numbers themselves meaningful under frame generation — a generated
    frame is not a rendered frame, so avg FPS, 1% lows and stutter counts all describe something
    other than what they claim. Scheduled as **Phase 9.6**, which reports a rendered rate alongside
    the presented one wherever frame type is known (§22.12), and **characterises** the physics
    signature of undeclared frame generation without shipping a rule for it (§22.13) — the only
    evidence in hand is one GPU, one title, one resolution.
- [ ] 22.7 Packaging — **partially blocked on out-of-band credentials.**
  - [x] NSIS installer (per-user install), bundled sidecar + license resource; `cargo tauri build`
    runs in CI and produced a working installer locally
  - [x] Crash reporting, opt-in by construction: a panic hook writes one local plain-text log and
    the UI offers a pre-filled GitHub issue. No SDK, no dependency, nothing sent automatically
  - [x] Release pipeline authored: `.github/workflows/release.yml` on `desktop-v*` tags, plus the
    `tauri.release.conf.json` overlay that keeps signing/updater config out of local builds
  - [ ] **Authenticode signing** — needs an Azure Trusted Signing account (`signCommand` is wired,
    credentials are not). Until then installers are unsigned and SmartScreen warns
  - [ ] **Auto-update channel live** — signed check/install/restart flow and `latest.json`
    publishing are wired, but `plugins.updater.pubkey` is a placeholder until the updater keypair
    is generated
- [x] 22.8 Surface `signature_valid` on the run report (§11.7) — a neutral badge when the payload
  matched, a `warn` badge when it did not, and **nothing at all** when no signature was checked.
  This closes the Phase 8.6 deferral: browser uploads carry no signature, so an "unsigned" stamp on
  every run would have read as a defect rather than the norm
- [x] 22.9 GPU utilization + VRAM from Windows performance counters (§22.2). PresentMon supplies
  neither (see 22.6), so the client samples `\GPU Engine(*)\Utilization Percentage` and
  `\GPU Process Memory(*)\Local Usage` itself — no elevation, no vendor SDK, no extra install —
  attributes them to the captured pid, and appends them to the capture stream as
  `HeimdallGpuUtilization`/`HeimdallGpuMemUsedMb`. Verified against live counters on an RX 9070 XT.
  - Parser `presentmon@1.1.0`: GPU utilization/clock/power/VRAM are now reported as **polled**, not
    frame-aligned. They always were — the parser used to claim otherwise, which would have let the
    per-frame `cpu-bottleneck` rule draw conclusions from a ~200 ms average. `SourceColumns` gained
    `periodicSensors` to express it.
  - GPU **clock** and **power** stay unavailable: PDH has no counters for them; they need vendor
    SDKs (ADLX / NVML / IGCL). Deferred, not forgotten.
- [ ] 22.10 (optional, needs data) A periodic-sensor bottleneck rule. `cpu-bottleneck` deliberately
  refuses polled data, so GPU load from 22.9 does not feed it. A rule that reasons over sampling
  intervals instead of frames is legitimate but is a DIFFERENT statistic — its thresholds cannot be
  inherited from the frame-aligned rule and need real captures to calibrate. Would land as its own
  rule code with its own confidence label (§16b.2), never as a flag on the existing one.
- **Verify**: hotkey capture on a real game → shareable link in <10 s after stop; run page shows
  declared hardware + `signature_valid: true`
  - [ ] Not yet performed. Requires a signed build (for `signature_valid` to be non-null) and a real
    game session on Windows. Hardware collection *was* verified against real silicon during
    implementation — DXGI/WMI/registry return correct GPU, driver, VRAM, CPU, RAM speeds, OS and
    resolution on a Ryzen 9800X3D / RX 9070 XT machine
- **Regression**:
  - [x] Rust unit tests (38): sidecar argv + CSV stream framing, hotkey state contract, driver/WMI/
    HAGS mapping, payload custody, Ed25519 sign → verify
  - [x] Desktop JS tests (57, must pass on ubuntu): capture state machine, live frame-time readout,
    transport adapter against a mocked `invoke`, methodology completeness, all four kit screens
  - [x] `packages/ingest-client` tests (20): `uploadCaptureBytes` parity with `uploadCapture`, and
    the `signPayload` hook signing the exact bytes it PUTs
  - [x] Ingest e2e: signed payload accepted; tampered payload records `signature_valid: false`
    **but is still accepted** (`jobs.test.ts` "records signature_valid as evidence"). Backed by a
    cross-language golden vector — the Rust client's exact signature + SPKI bytes are pinned in
    `signing.rs` and re-verified by Node in `verify-run.unit.test.ts`, so an encoding drift cannot
    silently turn every desktop run into `signature_valid: false`
  - [ ] Parser golden tests for any new real fixtures (hand-verified expected numbers) — with 22.6
  - [x] CI builds the Tauri app on Windows runner (`cargo tauri build`, NSIS bundle)

### Phase 9 Regression Gate
- [x] `pnpm verify` exit 0 across the widened workspace (8 projects); `cargo fmt --check`,
  `cargo clippy -D warnings -D clippy::perf` and `cargo test` clean; `pnpm check:deps` passes
- [ ] CI green including the Tauri build — the workflow is written and the bundle builds locally,
  but it has not yet run on a GitHub Windows runner
- [ ] Desktop capture → upload → report works end-to-end on Windows (the **Verify** run above)

**Outstanding, all needing action outside this repo:**
1. **A capture from an FSR3 / AFMF / DLSS-FG title** (22.6). Everything else about the fixture
   sweep is either done or established as unreachable — see 22.6 above.
2. **An Azure Trusted Signing account** (or equivalent Authenticode certificate). Purely an
   account-and-billing step; `signCommand` and the CI env are already wired.
3. **The Ed25519 payload keypair.** Run
   `pnpm --filter @heimdall/desktop exec node scripts/generate-signing-key.mjs --out <path outside the repo>`,
   then private half → repo secret `HEIMDALL_SIGNING_PRIVATE_KEY`, public half →
   `HEIMDALL_SIGNING_PUBLIC_KEY` on the server. The script's PKCS#8 output is pinned by a Rust test,
   so it cannot fail at release time.
4. **The Tauri updater keypair.** `tauri signer generate` → public key into
   `tauri.release.conf.json`, private key + password into CI secrets.
5. **A production hub origin** for `HEIMDALL_API_BASE_URL`, plus a real bundle identifier —
   `dev.heimdall.capture` is a placeholder and is baked into installer upgrade paths, so it must
   change before the first signed release, not after.
6. Carried from Phase 8.6: `@visual` baselines. Now a one-click job — run the
   **Regenerate visual baselines** workflow (`workflow_dispatch`), which generates the ubuntu
   `-chromium-linux.png` set on the runner that asserts them, re-asserts against a clean run, and
   opens a PR with the diffs to review.

---

## Phase 9.5: Desktop Capture — Linux / SteamOS (MangoHud watcher) — §23–§24

> Phase 9 shipped a Windows client that spawns a capture tool. Linux gets the same product surface
> through a different model: Heimdall injects no overlay (§23.1). MangoHud is the user's, driven by
> MangoHud's own logging hotkey, so the client **watches for a log** rather than starting a tool.
> That changes the state machine (an `armed` state before `capturing`), the onboarding contract, and
> what the app can honestly promise about live data. Everything after the bytes — parse, sign,
> upload, claim — is the same code on both platforms.

- [x] **Rust capture-backend seam.** `CaptureBuffer` + `CaptureTarget` moved out of `presentmon.rs`
  into a source-neutral `stream.rs` (the watcher's tail reads need exactly the framing PresentMon's
  stdout gets). `capture.rs` keeps the session, the event contract and shutdown; two `#[cfg]`
  backends decide only how rows arrive. New event `capture://armed { logDirs, hint,
  liveTraceExpected }`; `capture://started` still means rows are flowing. `start_capture` returns a
  tagged `CaptureStart` (`started` | `armed`) rather than assuming a capture began.
  - `CaptureBuffer` gained `with_preamble_rows` so MangoHud's two sysinfo rows are not counted as
    frames — the Complete screen's count has to match what `parseAnyCapture` finds in the same bytes.
- [x] **23.1 MangoHud log watcher.** Pure `mangohud.rs` (config parsing in both file and
  `MANGOHUD_CONFIG` forms, candidate-directory resolution **including Flatpak Steam's config**,
  newest-log-after-arm selection, MangoHud header sniff mirroring `detect.ts`, quiesce rule, log-name
  → game name, `--version` → `captureTool`) + a `#[cfg(target_os = "linux")]` 500 ms polling watcher
  thread. Read-only config detection: we report what is missing and print the exact lines, and never
  write a file we do not own. New `AppError::NoCaptureLog` (names MangoHud's hotkey) and
  `AppError::NoLogFolder` (the hard gate — with no `output_folder` there is nothing to watch).
- [x] **23.2 Mesa-aware hardware snapshot.** New `linux.rs`, `win.rs`'s sibling. MangoHud's sysinfo
  row is the preferred source and `apps/desktop/src/lib/hardware.ts` enforces that precedence before
  `uploadCaptureBytes`'s merge can invert it — without which `/sys` would overwrite `Mesa 26.1.4`
  with a kernel module name and every Linux driver-currency rule would miss. Dependency-free reads
  for `cpu`, `ramGb`, `os` + kernel, PCI `gpuVendor`, `mem_info_vram_total`, and a
  display-server-free `resolution`. RAM speeds and HAGS come back **absent/unknown**, asserted by
  test.
- [x] **Environment is a checks contract.** `Environment` carries `platform` + `checks:
  Vec<EnvCheck>` + `watcherMode` instead of two named booleans; each check carries its own label,
  hint, config lines and `blocking` flag, produced by the side that ran it (`env.rs`).
  `needsOnboarding` reads one contract. Non-blocking checks (sensors, `log_interval`) never gate the
  app — diagnostics skip rather than fail.
- [x] **Frontend.** `armed` screen between ready and capturing, with a `disarm` toggle intent so
  cancelling is not reported as a capture failure; onboarding renders from `checks`; the
  "MangoHud is logging — the trace appears when it flushes" copy replaces an empty chart when no
  `log_interval` is set.
  - **Bug fixed:** `LiveFrameTimes` treated the first row as the header. A MangoHud log's first row
    is a sysinfo key row, so it found no frame-time column and silently blanked the live chart for
    every Linux capture. It now scans a bounded preamble.
- [x] **Parsers.** `MANGOHUD_COLUMNS.periodicSensors` covers the whole sensor set (MangoHud has no
  per-present timing columns, so nothing it logs is frame-aligned); `mangohud@1.1.0`.
  `amd-mesa-basic.csv` got its missing provenance row.
- [x] **24.1 Packaging.** `tauri.conf.json` split into `tauri.{windows,linux}.conf.json` — required,
  not cosmetic: `bundle.externalBin` is validated by `tauri-build` at build-script time, so
  `cargo clippy` itself failed on Linux. AppImage + deb targets, a Flatpak manifest whose narrowly
  enumerated read-only sandbox grants are the substantive part, `fetch-presentmon.mjs` a no-op off
  Windows (after its version-pin check), and a `desktop-linux` CI job that compiles the
  `#[cfg]`-ed-out halves at all.
- [ ] **24.2 Real MangoHud fixture flip — NOT DONE.** Requires a real anonymized MangoHud export
  landed under procedure 16a.1. All three `SENSOR_AVAILABILITY.mangohud.*` cells stay `synthetic`,
  so the `gpu_vram_used` (assumed GiB) and sysinfo `ram` (assumed MB above 256) unit questions in the
  fixtures README wanted-list remain **open**. The flip-honesty test enforces this; do not soften it.

- **Verify** (automated): ~45 new Rust tests, all pure, so they run on the Windows job too — conf
  parsing in both forms, candidate-dir order incl. Flatpak Steam, newest-log-after-arm selection,
  stale-log and non-MangoHud rejection, quiesce, chunk-boundary reassembly with a MangoHud preamble,
  and `linux.rs` mappers over `/proc` and `/sys` fixture strings. JS: armed transitions,
  `needsOnboarding` over checks, MangoHud preamble in the live readout, hardware-merge precedence,
  Linux onboarding render, config-split regression. Parsers: alignment `false` for all five MangoHud
  sensors, `mangohud@1.1.0`.
- **Verify** (manual, the real gate — **NOT YET RUN**): install MangoHud, set `output_folder` +
  `log_interval`; arm Heimdall, press MangoHud's hotkey in-game, capture ~60 s, stop; confirm the
  live trace updates and the Complete screen shows frames/avg/lows; upload and confirm the run page
  shows GPU/CPU from sysinfo, `gpuDriver: Mesa <version>`, `os` carrying distro + kernel, and that
  the driver-currency diagnostic picks the **Mesa** baseline (`DRIVER_COMPONENT_SQL → mesa`) rather
  than a vendor package; confirm RAM-speed diagnostics stay silent rather than firing on absent data;
  repeat with `log_interval` unset to confirm the honest fallback copy; install the deb and the
  AppImage and confirm the watcher finds logs from both a native and a Flatpak-Steam game.
- **Regression**: `cargo clippy`/`cargo test` on both runners; `cargo tauri build --bundles
  appimage,deb` on ubuntu; the Windows job stays green after the `externalBin` move.

### Explicitly not verified by this phase — do not imply otherwise
- **SteamOS gaming mode and the Steam Deck.** No Deck was available. The sysfs reads are chosen to
  need no display server and the watcher needs no window, but that is reasoning, not a result.
- **The Flatpak build's sandbox grants** against a real Deck install. The manifest has never been
  built or run.
- **NVIDIA and Intel MangoHud cells.** Synthetic, open contributions — the same resolution §22.6
  reached for PresentMon.
- **Cross-platform compile of the Linux halves was not run locally** (a Windows dev box cannot
  cross-compile a GTK/WebKit Tauri target). The `desktop-linux` CI job is the first thing that
  type-checks `#[cfg(target_os = "linux")]` code.

### Phase 9.5 Regression Gate
- Linux capture parity with Windows; both clients on the same ingest contract

---

## Phase 9.6: Frame Generation — honest numbers and physics-based evidence — §22.11

> Phase 9 stopped a frame-generated run from *claiming* it was not generated (§22.11). It did not
> make its numbers mean anything. A generated frame is not a rendered frame, so avg FPS, 1% lows and
> stutter counts on such a run all describe something other than what they say — measured on an
> RX 9070 XT, Cyberpunk 2077 reported 243.9 avg FPS with frame generation on against 130.7 with it
> off. This phase is about the numbers, and about detecting the case where nobody declared anything.

**Three decisions settled before implementation**, each of which was an open question in the §22.11
writeup:

1. **The rendered-frame summary is stored, outside `RunSummary`** — computed server-side in the
   verify worker, persisted in a new nullable jsonb column. `RunSummary`, `summaryMismatch` and the
   client upload contract are untouched, so the §11.5 recompute gate does not move. The alternative
   (derive it in the browser at read time) needs no migration but strands the number on the run page,
   out of reach of `/games`, `/compare` and any list.
2. **§22.13 ships as characterisation only** — the statistics are computed and stored, the findings
   are written up, and **no rule fires and no run is annotated**. The only frame-generation evidence
   this project holds is one GPU, one title, one resolution; a threshold calibrated on n = 1 that
   accuses honest uploaders is the failure §0.5 exists to prevent. The rule gets its own phase once
   multi-vendor captures land.
3. **The toggle switches the stat tiles *and* the frame-time chart.** A trace still drawn over
   presented frames underneath rendered numbers contradicts itself — and the rendered stream has its
   own median, so it has its own stutter threshold.

> **Implementation status.** 22.12 and 22.13 are implemented on `phase-9.6-frame-generation`;
> `pnpm verify` exits 0 across all 8 projects, `cargo test` is 108/108, `pnpm check:deps` passes.
> Two numbers the plan left open were settled during implementation: `MIN_RENDERED_INTERVALS = 10`
> (matching `INGEST_LIMITS.minFramesPerRun`), and `PHYSICS.recomputeTolerance` is KEPT with a
> cross-reference comment at `floatsMatch` rather than deleted. Two corrections to the text below
> are noted inline. Still outstanding: the DB-backed test tier and the e2e/`@visual` suites have
> not been run (no Docker/`TEST_DATABASE_URL` on the dev box) — see the phase gate.

- [x] 22.12 **Dual summary where frame-type evidence exists.** Compute a second summary over
  rendered presents only, and offer a toggle on the run report: "how fast did it render" vs "how
  smooth did it feel". Both are legitimate answers to different questions, which is why this is a
  toggle and not a replacement.
  - Only available where the capture reports frame type. AMD frame generation carries no evidence
    (§22.6), so the toggle is absent there — stated, not silently omitted.
  - Presentation only. `frameGeneration` is already a comparability key, so declared-FG and
    declared-non-FG runs are in different buckets regardless; this does not touch pooling.

  - [x] **The coalescing rule — the crux, and the thing that is easy to get quietly wrong.** A
    rendered summary is **not** a filter of `generated === false` rows. `frameTimeMs` is an interval,
    so dropping the generated rows drops their durations too and the rate is unchanged: on the
    measured capture, 7,120 rendered rows over their own 4.10 ms mean interval recompute to
    `1000 × 7120 / (7120 × 4.10)` = **243.9 FPS**, bit-for-bit the presented number. The rendered
    series is the set of intervals **between consecutive rendered presents**, so a generated
    present's time is absorbed into the interval that contains it.
    - Arithmetic check against the measured pair: 7,120 rendered presents → 7,119 intervals over
      ~58.4 s → **121.9 rendered FPS**, against **130.7** measured with frame generation off. The
      −6.7% residual is the cost of running frame generation itself, which consumes base render
      budget. That agreement is the only evidence the algorithm measures what it claims — it belongs
      in the docs writeup.
    - **`frameTimeMs` is forward-looking on the only profile that can carry frame type.** Verified on
      `fixtures/presentmon/v2-amd-real.csv`: `10058.6817 + 8.6357 = 10067.3174`, exactly the next
      row's `CPUStartTime`, on four consecutive rows of real hardware. So `d[i] = t[i+1] − t[i]`, and
      the accumulator **starts at** a rendered present and closes when it **reaches** the next one
      (exclusive). The backward reading is off by one row per boundary — harmless on a strictly
      alternating stream, but it moves p95/p99, the lows and the stutter count on any irregular one.
    - `v2-v1-metrics-amd-real.csv` proves the two PresentMon profiles genuinely disagree:
      `2.01124880 − 2.00495280 = 6.296 ms` is row **2**'s `msBetweenPresents`, not row 1's — backward.
      A `FrameType` column can only reach us on the v2 profile, so **gate `generatedColumn` on `isV2`**
      in `presentmon.ts:79` (today `findColumn(header, ["frametype"])` runs for every profile). One
      line, and it makes the convention structural instead of documentary.
      - **Correction from code review — the gate was implemented and then REVERTED.** The coalescer
        is not the column's only consumer: `reconcileGeneratedFrameTech` (§22.11) keys on a generated
        frame having been seen, and `frameGenerationObserved` feeds the capability manifest. Neither
        cares about the interval convention, so gating the parser bought the coalescer nothing it
        needs — PresentMon only emits `FrameType` on v2 output anyway — while costing §22.11 the
        evidence that stops a frame-generated run keeping a declared `none`. Losing that is the
        §0.5-class failure. The column is read on every profile; the convention is documented where
        it is applied, in `frame-generation.ts`. `presentmon` stays at **1.2.0** (the reverted gate
        was the only behaviour change, so the 1.3.0 bump was withdrawn too).
    - Do **not** rederive intervals from `time_ms` deltas to dodge the convention.
      `computeFrameParquetSummary` drops `times` (`frame-metadata.ts:304`) to shed 4 MiB, and
      `buildFrameSeriesFromColumns` normalizes `times` **in place**, so server and browser would be
      working from different arrays — losing bit-identity exactly where it is needed.
    - **Correction from implementation:** the "243.9 = 243.9" identity above holds only where
      present durations are UNIFORM (which the measured AMD capture was, every row `Application`).
      Where rendered and generated presents differ in duration, naive filtering lands on neither
      rate — on an 8 ms / 0.4 ms stream it gives 125 FPS against 238.1 presented and 119.0
      rendered. Filtering is wrong in a third direction, not merely a no-op. Both cases are tested.
    - Edge cases, all named constants and all tested: `generated === undefined` inside an
      evidence-bearing run is **absorbed** into the enclosing interval (the time elapsed; we just
      don't know what bounded it); fewer than `MIN_RENDERED_INTERVALS` rendered presents yields no
      summary; and a run with evidence but **zero** generated frames yields no rendered summary
      either — not because it would duplicate the presented one but because it would **not**: the
      coalescer returns `d[0..n−2]`, differing in the 3rd–4th significant figure. Two numbers claiming
      to be the same rate and disagreeing slightly is worse than one number.

  - [x] **New `packages/parsers/src/frame-generation.ts`.** `coalesceRenderedIntervals(frameTimesMs,
    presentTypes)` returning the intervals plus `startRows` (each interval's originating row, so the
    browser can rebuild the chart on the real time base), the three present-type counts, and
    `leadingMs`/`trailingMs` so the docs can show the accounting closes. Then
    `computeRenderedFrameAnalysis(...)` feeding those intervals straight into the **existing**
    `computeRunSummaryFromFrameTimes` — no percentile, low or stutter definition is rederived, which
    is what makes server/browser agreement structural rather than merely tested.
    - **Correction from code review — `no-generated-frames` does NOT ship.** The plan's four-state
      union splits "no frame-type column" from "a column that read `Application` everywhere", and
      the second state licenses the copy "the presented rate is already the rendered rate". That
      claim is false for exactly the captures this phase is about: the reference RX 9070 XT capture
      had frame generation ON and 14,241 rows every one `Application`. §22.11 already settled that
      the two are indistinguishable and the column's presence proves nothing, so both now reach
      `no-frame-type-evidence` and a test asserts they are `toEqual`. Three shipped states, not four.
    - Result is a **discriminated union on `state`**, not a nullable summary: `available` |
      `no-frame-type-evidence` | `no-generated-frames` | `too-few-rendered-presents`. Precedent is
      `vramCapacitySchema` — "a discrete total, or a typed reason it is unavailable". The server
      decides *why* once; the UI reads one field; §22.12's "stated, not silently omitted" becomes
      structural rather than a copy convention three surfaces must remember.
    - Tri-state present-type codec (`PRESENT_FRAME_TYPE` + `presentFrameTypeCode`) goes in
      `packages/shared/src/parquet.ts` beside `parseOptionalFrameParquetGenerated`, because the
      browser decoder must not import parsers. A `Uint8Array` of codes, never a boxed
      `(boolean | null)[]` — that object graph is what the columnar path exists to avoid.
    - The coalescer itself must live in parsers (it calls `computeRunSummaryFromFrameTimes`, and
      shared cannot depend on parsers). That costs nothing new in the browser bundle: `stutters.ts:10`
      already statically imports `stutterThresholdMs` from `@heimdall/parsers`. The comment at
      `frame-metadata.ts:307-310` implies otherwise and should be tightened while we are there.

  - [x] **Compute it in the existing Parquet pass — but not inside the chunk callback.**
    `readFrameParquetColumn`'s own doc comment records that **row groups may arrive unordered**
    (hence its `seenRows` presence bitmap), so any accumulator in `onValue` would coalesce in
    delivery order and produce garbage on a multi-row-group file — nondeterministically, passing every
    single-row-group fixture we own. Fill a `Uint8Array(frameCount)` of type codes during the
    `generated` pass, then coalesce in row order **after** it resolves.
    `FRAME_PARQUET_COLUMN_NAMES` orders `frame_time_ms` before `generated`, so the frame times are
    already complete when that pass ends.

  - [x] **Migration `0040_frame_analysis.sql`** — `runs.rendered_frame_analysis jsonb`,
    `runs.present_time_profile jsonb`, `runs.frame_analysis_version integer`, plus the nulls-first
    partial index, following `0030_diagnostics_watermark.sql`. `FRAME_ANALYSIS_VERSION = 1` in
    `packages/shared/src/constants.ts` next to `DIAGNOSTICS_RULE_GENERATION`.
    - **Do not copy 0030's backfill.** 0030 could honestly `set diagnostics_rule_generation = 1`
      because those findings really had been evaluated at generation 1. No existing row has ever had
      a frame analysis computed, so stamping would permanently hide the entire historical corpus from
      the lane that exists to reach it. Leave the watermark null and let `nulls first` make those
      rows highest-priority — the same reason 0030's own comment insists the predicate carry an
      `is null` branch.
  - [x] **Fourth lane in `FULL_REPROCESS_ENQUEUE_SQL`**, mirroring `diagnostics_generation_candidates`
    verbatim, with `FRAME_ANALYSIS_VERSION` as `$6`. Write paths that must stamp:
    `applyVerificationResult` and `applyReprocessResult` (so `ReprocessResult` gains fields);
    `failVerificationJob` never stamps, which is exactly the population the `is null` branch reaches;
    and `insertRun` deliberately does not — there is no client contract for a rendered summary and
    inventing one would reintroduce the trust violation this phase removes. Say so in a comment or
    someone will "fix" it.
    - Two traps in those CTEs. Both use `coalesce($n, runs.col)` for nullable values — **do not**
      coalesce these: a run whose analysis becomes unavailable under a new algorithm version must
      *lose* the value, not silently keep a stale one. And both carry hardcoded positional offsets
      (`diagnosticInsertSql(1, 20, …)` / `(1, 18, …)`), so **append** the new parameters after the
      diagnostics arrays rather than renumbering — that class of bug writes the wrong value into the
      right column with no type error and no test failure.

  - [x] **Wire + UI.** `renderedFrameAnalysisSchema` as a `z.discriminatedUnion("state", …)` added to
    `runResponseSchema`; `RUN_WITH_SUMMARY_SELECT` + `RunRow` + `rowToRun` in `db.ts` (two single-row
    callers only, so no list-query cost).
    - **`present_time_profile` stays off the wire.** §22.13 ships with no user-visible annotation;
      shipping an unexposed suspicion score to every viewer is precisely what §0.5 warns against.
      Comment the omission where the `ownerId` omission is commented, so the reasoning survives.
    - `page.tsx:60` does `runResponseSchema.parse(run)` and zod strips unknown keys — forget the
      schema field and the column plumbs all the way from Postgres to the page boundary and then
      vanishes with no error. Pin it with a schema-test assertion.
    - **Correction:** `busy-readiness.ts` lives in `apps/web/src/components/run/`, not `lib/run/`;
      `rendered-rate-readiness.ts` sits beside it there.
    - New `rendered-rate-readiness.ts`, a structural copy of `busy-readiness.ts`: one module owns the
      verdict and its reason string, shared by the toggle, the caption and the tests. A `Segmented`
      (`Presented` | `Rendered`) in a header row above `RunStatTiles` — not in the chart header, which
      would imply chart-only scope — disabled with a **visible** reason exactly as the busy `Switch`
      already is.
    - Copy for the unavailable cases, in product voice: no evidence → *"Capture does not report frame
      type — a rendered-only rate cannot be computed."* (long form naming the Intel-PresentMon
      provider requirement and why AMD frame generation carries no label); evidence but nothing
      generated → *"This capture reports frame type and shows no generated frames, so the presented
      rate is already the rendered rate."*; too few → *"Only N presents were labelled as rendered —
      too few to time a rendered rate."*; unverified → *"Rendered rate appears once verification
      recomputes this run."*
    - **Replace the "Generated frames %" tile in rendered mode.** Fed the rendered summary it reads
      **0%** for a run that is 50% generated — re-manufacturing the exact false claim §22.11 removed.
      Swap it for an "Interpolated presents" tile driven by the analysis blob's counts.
    - Chart: `FrameDecodeOptions` gains `generatedColumn?: boolean` (default **false**, threaded only
      when the analysis is `available`, same rationale as `busyColumns`); `decodeFrameParquetToSeries`
      gains a lazily-allocated `readGeneratedColumn` mirroring `readBusyColumn`; `FrameSeries` gains
      `presentTypes?: Uint8Array`; new `rendered-series.ts` gathers `times[startRows[k]]` so the x
      axis keeps the real time base (a `0, Δ, 2Δ…` base would silently compress the run) and feeds the
      same `buildFrameSeriesFromColumns`. `FrameTimeChart` needs no prop change — pass the rendered
      `avgFps` so `bandThresholdMs` picks the right good-zone band. **Memoize** the coalesce and its
      stutter indices; a 500k-frame recoalesce per toggle click is a visible hang.
    - **Force `showBusy` off in rendered mode**, with a fourth `busyOffReason`: `cpuBusyMs`/`gpuBusyMs`
      are per-present and do not survive coalescing, so drawing them against rendered intervals would
      be a fabricated trace.
    - Extend the switch to `SmoothnessBars` too — it derives from the same three FPS numbers, and
      leaving it on presented values directly beneath a rendered chart is the inconsistency this
      phase is about. `generateMetadata`'s share-card FPS stays on the canonical presented value;
      record that choice in the docs.

- [x] 22.13 **Physics-based frame-generation evidence — characterisation only, no rule.** Detect
  undeclared frame generation from WITHIN a run, not by comparing it to an aggregate.
  - The signal: sub-millisecond presents. The two captures above showed a 0.32 ms minimum with
    frame generation on versus 3.11 ms with it off. A 0.32 ms present is not a plausible rendered
    frame at that resolution. `MIN_FRAME_TIME_MS` is 0.01, so these presents survive parsing — the
    signal reaches storage intact.
  - Why within-run and not ratio-vs-average: an aggregate baseline is already contaminated by the
    undeclared runs it is meant to find; it is inert below the §17.4/§18.2 cold-start threshold, so
    it does nothing at current data volume; and 2x is not a clean constant (DLSS4 multi-frame
    generation is 3–4x, and the multiplier drifts with base framerate). Comparability keys control
    resolution/preset/upscaler/scene, but settings vary within a preset and a CPU-bound section
    moves FPS more than frame generation does.
  - [x] Store a `present_time_profile` from the same Parquet pass: `minFrameTimeMs`, the low-tail
    nearest-rank percentiles (`p0_1`/`p1`/`p5` — free, `summarizeSortedFrameTimes` already sorts
    ascending), `subMillisecondPresentCount`/`Fraction`, `adjacentSubMillisecondPairFraction`, and
    **`medianOverMinRatio`**. Threshold as a named constant
    `FRAME_GENERATION_EVIDENCE.subMillisecondPresentMs` in `packages/shared/src/integrity.ts`, beside
    `PHYSICS` where the §18.2 layer already lives — never an inline number.
    - `medianOverMinRatio` is the one to lead the writeup with, because it is **scale-free** —
      independent of base framerate, resolution and title, which answers this section's own objection
      that the multiplier drifts. On the measured pair it separates 5x: 4.10/0.32 = **12.8** with
      frame generation on against 7.65/3.11 = **2.46** with it off. On n = 1 it is still worth
      nothing, and the doc must say that in those words.
  - [x] **No rule, no annotation, nothing on the wire.** The statistics accumulate from real uploads
    until they can be calibrated on more than one vendor. **Evidence, never an accusation** (§0.5):
    telling an honest uploader their run looks like cheating is a worse failure than missing a
    dishonest one, and a false positive is unfalsifiable from the uploader's side. A threshold fitted
    to one GPU, one title and one resolution cannot carry that weight.
  - [x] `docs/frame-generation.md`: what the pipeline can and cannot see (only PresentMon v2
    `--track_frame_type`, and why AMD cannot); the measured RX 9070 XT table with capture conditions;
    the coalescing definition with the worked arithmetic (243.9 presented → 121.9 rendered vs 130.7
    measured FG-off, and why −6.7% is expected); why naive filtering is wrong, with the 243.9 = 243.9
    identity; each stored statistic labelled **n = 1, one vendor, one title, one resolution**; what
    calibration would require and the known false-positive shapes (menus, loading screens, capped and
    idle sections); and the explicit statement that no rule ships and no run is annotated. Cross-link
    from wanted-list item 9 in the fixtures README.

- [x] **Housekeeping this phase must not leave behind.**
  - [x] `packages/parsers/fixtures/README.md:80-81` still claims "`generatedFramePct` is always 0 and
    `generatedFrameTech` always resolves to `none`" — §22.11 already invalidated that and this phase's
    fixtures invalidate it twice over.
  - [x] Settle `PHYSICS.recomputeTolerance` (`integrity.ts:30-33`), dead except for its own test.
    **Do not** wire it into `verify-run.ts`: `floatsMatch` uses a `1e-6` relative epsilon, so adopting
    `0.01` would loosen the integrity gate by four orders of magnitude. Either delete it with its
    test, or comment at `floatsMatch` that `summaryMismatch` deliberately does not use it and why.
    This phase adds a second recompute path, so a reviewer will ask.

- **Verify**: a frame-generated capture with frame-type evidence reports both rates, and the toggle
  switches the tiles, the smoothness bars and the chart together; a capture with no frame-type
  evidence shows the toggle disabled with its reason as visible text; `present_time_profile` is
  populated on both members of the measured RX 9070 XT pair and appears nowhere in the API response
  - [ ] **Not performed on a real capture, and not performable here.** No frame-generated capture
    with frame-type evidence is obtainable on the available AMD hardware (§22.6) — the same block
    that has held wanted-list item 9 open. The synthetic fixture below is the acceptance path;
    the real-capture verification lands with that fixture, not with this phase
- **Regression**:
  - [x] New `frame-generation.test.ts`: forward-convention coalescing on a hand-built stream; the
    `renderedCount − 1` invariant; `Σ intervals = t[last] − t[first]`; leading/trailing accounting;
    `undefined` rows absorbed; each of the **four** unavailable/available states. Property test
    (fast-check is already a parsers devDependency): an all-`false` stream yields `d[0..n−2]`,
    proving the "it would just duplicate the presented summary" assumption false
  - [x] Dual-summary golden fixture: `presentmon/v2-frame-generation.csv`, synthetic per the
    `fixtures/README.md` 16a.1 procedure. **12 PAIRS, not the 12 rows the plan suggested** — 6
    rendered presents bound only 5 intervals, below `MIN_RENDERED_INTERVALS` (10), so the suggested
    shape would correctly return `too-few-rendered-presents` instead of a rate. Both hand-computed
    rates are unchanged by the larger count: presented `1000×24/100.8` = 238.095, rendered
    `1000×11/92.4` = 119.048. The golden harness now asserts `renderedFrameAnalysis` whenever a
    fixture declares one. The application-only case is covered by a unit test asserting it is
    `toEqual` the no-column case (see the `no-generated-frames` correction above) rather than a
    second CSV
  - [x] Toggle absent — and said to be absent, as visible text — when the capture carries no
    frame-type evidence; busy overlay forced off with its reason in rendered mode. Plus the tile
    swap (Generated frames % → Interpolated presents) and all four readiness states
  - [x] `verify-run.unit.test.ts`: **`summaryMismatch` is unchanged by a frame-generated run**, and the
    rendered analysis never influences the validated/flagged verdict. This is decision 1's guarantee
    and the one a future reader is most likely to "fix"
  - [ ] Reprocess: the fourth lane enqueues a null-watermark run and skips a current-version one
    (mirroring the §17.8.0 case), both write paths stamp, and the new lane is proven index-backed by
    the existing EXPLAIN assertion — **NOT RUN: needs Postgres.** Partially compensated by
    `repo/frame-analysis-params.unit.test.ts`, which runs on the DB-free tier and asserts the
    highest `$n` each write statement references equals the parameters supplied, that the two jsonb
    values are appended last, that neither is `coalesce`d, and that the lane binds `$6` with no
    unreferenced gap. Verified by mutation. The EXPLAIN assertion still needs
    `runs_frame_analysis_version_idx` added and a real run
  - [ ] Functional e2e (non-`@visual`): `global-setup.ts` now seeds the three columns directly (since
    `insertRun` deliberately does not), and the fixture's analysis was confirmed `available` —
    4,320 rendered / 2,880 generated, 68.99 rendered FPS against 114.96 presented, exercising the
    off-by-one on a non-alternating stream. **The suite itself has NOT been run: needs Docker**
  - [ ] `@visual` baselines will churn: the toggle changes the run-page header region. Use the
    one-click **Regenerate visual baselines** `workflow_dispatch`, planned rather than discovered in CI
  - [x] Physics rule fires on a known-FG capture and stays silent on the matched non-FG one —
    **deferred with the rule** (decision 2). No rule ships this phase, so there is nothing to assert

### Phase 9.6 Regression Gate
- No run reports a number it cannot support: a frame-generated run with frame-type evidence reports
  its rendered rate as well as its presented one, and a run without that evidence says so rather than
  implying either
- `RunSummary`, `summaryMismatch` and the client upload contract are byte-for-byte unchanged — the
  §11.5 recompute gate did not move to accommodate this phase
- **Outstanding before this phase can be called done:** the DB-backed vitest tier (reprocess lane,
  `repo.test.ts`, the EXPLAIN index assertion), the functional e2e suite, and the `@visual`
  regeneration. All three need Docker or a `TEST_DATABASE_URL`, neither of which was available on
  the dev box — they have not been run, not merely not been written. CI covers all three.
- The frame-generation signature is characterised, stored and documented, and **no run is annotated
  or auto-rejected for it**; the calibration gap is written down rather than papered over with a
  threshold fitted to one machine

---

## Phase 10: Before/After Validator — §25–§26

> "Tag two runs, get a plain-English delta." Schema already exists: `comparisons` table
> (migration 0003). Comparability gating already exists: `packages/shared/src/comparability.ts`
> is the single source of truth for "which runs may pool" — reuse it, don't fork it.

- [ ] 25.1 Compare builder: pick before/after from "My runs" (or two public run URLs); persist to
  `comparisons` (owner-scoped)
- [ ] 25.2 Comparability gate: same game × workload × comparable settings via the shared module;
  incomparable pairs get an explicit caveat, not a silent number
- [ ] 25.3 Delta computation: avg / 1% / 0.1% lows, stutter count, percentiles — computed from
  canonical (validated) summaries only
- [ ] 25.4 Plain-English summary in the product voice: *"Your 1% lows improved 16.7%. Enabling
  EXPO meaningfully reduced micro-stutters."* — name the change, quantify it, no hype; honest
  hedging when capture length makes 0.1% lows noisy
- [ ] 26.1 Shareable `/compare/[id]` page: side-by-side smoothness tiers + overlaid D3 frame-time
  traces + distribution shift; visibility follows the more-restrictive of the two runs
- [ ] 26.2 Diagnostics tie-in: if the before-run had a finding (e.g. RAM below rated) and the
  after-run cleared it, say so — this is the product's payoff loop
- **Verify**: EXPO-style before/after produces a correct, comparability-gated, shareable delta
- **Regression**:
  - [ ] Delta math unit tests (hand-computed pairs, incl. sign conventions on "lower is better")
  - [ ] Incomparable pair → caveat state, never a bare percentage
  - [ ] Visibility: compare page 404s if either run is private to the viewer
  - [ ] e2e: build compare → share link → logged-out view

### Phase 10 Regression Gate
- Compare flow e2e green; comparability rules shared (no duplicated pooling logic)

---

## Phase 11: Creator Video Export — §27

> Scrolling frame-time overlay for YouTube/benchmark videos. Visual target: `ExportPage` in
> `design/ui_kits/web/screens.jsx` (§27). R2 `exports/` prefix has been reserved since Phase 2
> (`§5.2`). Kit copy commits us to **in-browser encoding** — "nothing leaves your machine."

- [ ] 27.1 Export page (`/runs/[id]/export`): mode picker — transparent WebM (alpha) /
  green-screen (#00B140) MP4-WebM / PNG sequence; resolution + fps presets (1080p60 default)
- [ ] 27.2 Offscreen render pipeline: replay the run's frame stream through the D3/canvas chart at
  a fixed timebase synced to capture time (so creators can align to gameplay footage)
- [ ] 27.3 In-browser encode via WebCodecs (VP9/AV1 alpha for WebM; PNG-sequence zip fallback for
  editors without alpha-video support); progress UI per the kit
- [ ] 27.4 Optional: save finished export to R2 under `exports/` (owner-only, counted against a
  quota, covered by the deletion cascade) — flip the write-lock and its `r2.test.ts` reservation test deliberately
- [ ] 27.5 Overlay styling honors the design system (JetBrains Mono numerics, tier colors) and
  stays legible over gameplay footage
- **Verify**: exported transparent WebM drops into a Premiere/Resolve timeline over gameplay and
  scrolls in sync; green-screen keys cleanly
- **Regression**:
  - [ ] Deterministic render test: fixed fixture → identical frame hashes for a sampled set
  - [ ] Timebase test: chart scroll position at t=30 s matches capture t=30 s
  - [ ] `exports/` authz: only the run owner can write/read; deletion cascade includes exports
  - [ ] Encode fallback path when WebCodecs alpha is unavailable

### Phase 11 Regression Gate
- All three export modes produce usable assets; export storage covered by privacy cascade

---

## Phase 12: ClickHouse Analytics — §28

> Cross-run/population analytics too heavy for Postgres. Env vars have been stubbed since Phase 4
> (`CLICKHOUSE_URL/USER/PASSWORD` — "leave blank until then"); `infra/clickhouse/` is empty.

- [ ] 28.1 Provision ClickHouse (Cloud or self-hosted); DDL in `infra/clickhouse/` (runs_flat,
  frames_agg tables; partition by game/month); migration runner script
- [ ] 28.2 Ingest path: batch ETL from Postgres summaries + R2 Parquet into ClickHouse (idempotent
  backfill + incremental on validation) — **aggregate-eligible runs only** (`public` + `validated`;
  reuse `aggregateEligibilitySql` semantics at export time)
- [ ] 28.3 Population analytics APIs: game × GPU × driver percentile surfaces, driver-version
  performance deltas across the population, hardware-tier percentile trends over time
- [ ] 28.4 Move heavy distribution/cohort reads (Phase 7/7.5) behind ClickHouse where Postgres
  indexes are the bottleneck; Postgres remains source of truth — ClickHouse is derived and rebuildable
- [ ] 28.5 Deletion propagation: run/account erasure removes derived ClickHouse rows (extends the
  §20.4 cascade); document in the privacy policy (the "Phase 12" note in `§1.4`)
- [ ] 28.6 Guardrails: query cost limits, per-endpoint caching, no quasi-identifying fields
  exported — canonical ids only (`§4.4`)
- **Verify**: population queries that time out on Postgres return interactively from ClickHouse;
  wipe-and-rebuild from Postgres+R2 reproduces identical aggregates
- **Regression**:
  - [ ] ETL idempotency: double-run produces no dupes
  - [ ] Eligibility: unlisted/private/flagged runs never present in ClickHouse
  - [ ] Erasure: deleted run absent after propagation job
  - [ ] Parity: sampled distribution from ClickHouse matches Postgres within rounding

### Phase 12 Regression Gate
- Analytics surfaces live on ClickHouse; privacy cascade extended; rebuildability proven

---

## Phase 13: macOS Capture (stretch) — post-§28

> Shared types already anticipate it: the macOS path shares one CPU/GPU pool
> (`packages/shared/src/types.ts`, `packages/parsers/src/sensor-availability.ts` — availability is
> **declared upstream, never inferred**).

- [ ] 13.1 Evaluate capture source (Metal Performance HUD / custom frame pacing via CAMetalLayer);
  no PresentMon equivalent exists — scope honestly before committing
- [ ] 13.2 Tauri client target for macOS; unified-memory hardware snapshot (shared CPU/GPU pool)
- [ ] 13.3 Sensor-availability matrix rows for macOS declared (not inferred), fixtures + flips
- **Verify/Regression**: same golden-fixture + ingest e2e bar as Phases 9/9.5

---

## Deployment / env checklist (do as needed, per phase)

- [ ] Neon Postgres provisioned; `DATABASE_URL` + pool/timeout guardrails set; at-rest encryption confirmed
- [ ] R2 bucket `heimdall-runs` + credentials + `R2_PUBLIC_BASE_URL` (custom domain)
- [ ] Cloudflare in front of the web app: TLS Full (Strict), HSTS, WAF baseline, bot mitigation (Phase 8.5 §8.5.6)
- [ ] Clerk production instance + webhook secret (Phase 8)
- [ ] `INTERNAL_JOBS_TOKEN` generated + platform cron hitting `/api/internal/jobs/drain`
- [ ] `HEIMDALL_SIGNING_PUBLIC_KEY` published once the desktop client ships (Phase 9) — the value
  is **publishable by design**; publishing it is what lets anyone verify a run's signature
  independently. Generate the pair per `docs/desktop-client.md`.
- [ ] ClickHouse credentials (Phase 12)
