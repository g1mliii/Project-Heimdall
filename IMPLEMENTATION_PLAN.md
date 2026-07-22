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
| Desktop client | Tauri 2 (Rust) — **Phase 9+**, `apps/desktop` is empty scaffolding | Bundled Intel PresentMon (Windows), MangoHud watcher (Linux/SteamOS), global hotkey, Ed25519-signed uploads |
| Parsing | `packages/parsers` — pure TS, runs in browser and server | Same code parses client-side (upload preview) and server-side (canonical recompute) |
| Testing | Vitest (unit), Playwright (e2e + visual baseline), golden fixtures | Every parseable fixture has a hand-computed `*.expected.json` |
| CI | GitHub Actions (`ci.yml`) | verify + migrations + e2e; Tauri job is a no-op until `Cargo.toml` lands (Phase 9, §0.8) |
| Monorepo | pnpm workspaces | `apps/*` + `packages/*` + `infra/*`; dependency minimum-age policy in `scripts/check-dependency-policy.mjs` |

---

## Repository layout (current)

```text
apps/web/              Next.js hub: pages (/, /upload, /runs/[id], /games/[slug]) + API routes
apps/desktop/          Tauri 2 capture client — empty until Phase 9
apps/driver-curation/  scheduled driver-currency ingest (Phase 6.6)
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
  and run) and a real end-to-end webhook test through an actual public tunnel (ngrok or similar) —
  today's webhook coverage signs payloads with the real `svix` library directly in-process, which
  proves the route's verification logic but has never received a request from Clerk's real servers

---

## Phase 8.5: Comprehensive Security Review

> Auth just landed — review the **whole surface** before building the desktop client on top of it.
> Run the `/security-review` skill against the branch, then work this checklist. Findings become
> issues; each fix lands with a regression test. Nothing ships to Phase 9 with an open High.

- [ ] 8.5.1 **AuthN/AuthZ:** every route re-audited against the Phase 8 authz matrix; IDOR probes
  on run ids / management tokens / claim flow; Clerk session handling; admin routes locked
- [ ] 8.5.2 **Tokens & secrets:** management-token hashing + constant-time compare still hold;
  `INTERNAL_JOBS_TOKEN` (drain route) rotation documented; no secret reaches the client bundle;
  logs redact tokens/keys
- [ ] 8.5.3 **R2 / upload path:** presigned PUT scope (key, content-length, expiry); nonce'd keys
  unguessable; `exports/` prefix still write-locked pre-Phase 11; upload limits (`§11.10`) enforced
  **before** a presigned URL is issued; Parquet parsing treated as hostile input
- [ ] 8.5.4 **Injection & parsing:** SQL parameterization sweep (repos + migrations helpers);
  hostile CSV/JSON parser fuzz (extend `malformed/*`); no user string reaches HTML unescaped;
  abusive game-name path (moderation) covered
- [ ] 8.5.5 **SSRF / egress:** `apps/driver-curation` fetchers pinned to allowlisted vendor hosts;
  redirects and content-type validated; timeouts + size caps
- [ ] 8.5.6 **Platform:** security headers (CSP, HSTS, frame-ancestors, referrer-policy) on the
  web app; Cloudflare in front of production (WAF, bot mitigation) — part of the deploy env work;
  Neon + R2 at-rest encryption verified still on (`§1.5` guardrail)
- [ ] 8.5.7 **DoS & abuse:** rate limits (per-IP + per-user) on create/finalize/delete/search/claim;
  drain endpoint auth; reprocess sweeps bounded (already) — confirm under adversarial input
- [ ] 8.5.8 **Supply chain:** `pnpm audit:deps` clean at moderate+; `check:deps` policy exceptions
  reviewed (wrangler exception still justified?); lockfile integrity in CI
- [ ] 8.5.9 **Privacy:** erasure cascade proven (DB + R2); hardware-fingerprint handling matches
  the privacy policy; no quasi-identifying data in logs/analytics
- [ ] 8.5.10 Fix all findings (severity-ordered), each with a regression test; document accepted
  risks in `docs/integrity-and-privacy.md`
- **Verify**: `/security-review` re-run reports no High/Critical; authz matrix green
- **Regression**: every fixed finding has a test that fails on revert

### Phase 8.5 Regression Gate
- Zero open High/Critical findings; accepted risks documented; `pnpm verify` green

---

## Phase 8.6: Run/Game Page Data Completeness (UI catch-up)

> Audited 2026-07-20 during Phase 8 manual testing: a lot of Phase 3–7.5 backend work — capability
> manifest, the full declared methodology profile, diagnostic evidence detail — is computed and
> stored but never rendered anywhere a user can see it. This phase closes that gap. No new backend
> work; every field here already exists in `packages/shared/src/types.ts` and is already flowing
> through the API. Visual target: extend the existing `RunPage.jsx`/`GamePage.jsx` kits (several of
> these — the settings-string subtitle, the verified shield badge — are already drawn in the kit
> and simply never got built).

- [ ] 8.6.1 **Capability manifest panel** (run page): `sensors` coverage, `presentationMode`,
  `syncMode`, `frameGenerationObserved`, `vramCapacity`, `caveats` — none of `capabilityManifest`
  is currently displayed. For `cpuBusyMs`/`gpuBusyMs`, make the bottleneck-data readiness explicit:
  show present/absent, frame-aligned/not safe for attribution, and the HAGS qualification when it
  applies
- [ ] 8.6.2 **Declared methodology, shown not just validated**: `RunHeader` subtitle should read
  the settings string per the kit ("Ultra · Ray Tracing: Overdrive · 1440p · DX12 · 62s capture");
  currently `methodologyManifest` is only read to name *missing* fields (`IncompleteProfileCard`),
  never to display the *declared* ones. Also missing on submission rows: `settingsPreset`, `scene`,
  frame-pacing (`capFps`/`vsync`/`vrr`/`refreshHz`), `gameBuild`, `captureTool`, `warmupPolicy`,
  `hags` — today split inconsistently between per-row and cohort-bucket display, several nowhere
- [ ] 8.6.3 **This run's own** `frameTimeP95Ms`/`frameTimeP99Ms`/`stutterCount` as stat tiles —
  currently these are only distribution-metric *options* on the game page, never shown as the
  run's own numbers
- [ ] 8.6.4 **Diagnostic evidence detail**: `DiagnosticEvidence.coverageFraction`, `sensors[]`,
  `metrics{}` (bottleneck-attribution percentages), `caveats[]`, and
  `provenance.{sourceUrl,referencedVersion,fetchedAt}` (the driver-update source link) are computed
  server-side and dropped before the card renders. For busy-time attribution, render human labels
  (not raw metric keys) for paired-frame coverage, paired sample count, CPU-bound/GPU-bound/
  cap-or-display-limited fractions, confidence, and HAGS caveats
- [ ] 8.6.5 **Hardware snapshot**: add `gpuVramTotalMb` (capacity, not just peak used) and
  `gpuVendor`
- [ ] 8.6.6 **`RunSummary.sampleCount`** as a visible number, not just a tooltip title on the
  confidence badge
- [ ] 8.6.7 Depends on **§20.3 (verified-reviewer tier)** landing first: the shield-check badge on
  `SubmissionsTable` rows (drawn in `GamePage.jsx`, no placeholder in the component yet) and
  activating the already-present disabled "Verified only" `Switch` in `DistributionSection`
- [ ] 8.6.8 **Busy-time timeline** (run page): when paired, frame-aligned `cpuBusyMs` and
  `gpuBusyMs` telemetry is available, offer a CPU Busy / GPU Busy / frame-time chart overlay;
  otherwise state why attribution and the overlay are unavailable. Never render missing samples as
  zero; retain the HAGS qualification. This extends the front-end Parquet chart projection only —
  no new server-side data model or API work
- **Verify**: run page and game page visually match the current `design/ui_kits/web/**` kit;
  nothing in `packages/shared/src/types.ts`'s domain model is silently dropped between API response
  and rendered DOM (spot-check by diffing a real API response against what's on screen)
- **Regression**: component tests asserting each newly-wired field renders from a fixture with that
  field populated

### Phase 8.6 Regression Gate
- Full domain model has a UI home; `pnpm verify` green; visual baselines updated deliberately (not
  casually) to match

---

## Phase 9: Desktop Capture Client — Windows (Tauri 2 + PresentMon) — §21–§22

> The second product surface. `apps/desktop` is empty scaffolding; the CI Tauri job un-no-ops the
> moment `Cargo.toml` lands (`§0.8`). Visual target: `design/ui_kits/desktop/CaptureClient.jsx`
> (ready → capturing → complete, `§22.4`). Parser fixture work: live-client confirmation of
> PresentMon cells per `packages/parsers/fixtures/README.md` (Phase 9 §22).

- [ ] 21.1 Tauri 2 scaffold in `apps/desktop` (Rust backend + web frontend using `@heimdall/ui`
  tokens); wire into pnpm workspace + CI (Tauri job now real)
- [ ] 21.2 Bundle Intel PresentMon as a sidecar binary; license/attribution; version pinned and
  recorded in the capture provenance (`§2.2`)
- [ ] 21.3 Global hotkey (default Shift+F11) start/stop; ~60 s guidance; tray presence
- [ ] 22.1 Capture pipeline: spawn PresentMon against the foreground game process → stream CSV →
  parse with `@heimdall/parsers` (same code as web) → live frame count + trace during capture
- [ ] 22.2 Hardware snapshot (GPU/driver/CPU/RAM speed + rated speed/OS/resolution, HAGS state) —
  **declared by the client**, per the `§8`/`§16a` contract in `packages/parsers` (columns.ts /
  presentmon.ts say these must come from the client, never inferred)
- [ ] 22.3 Ed25519 payload signing (key in client; server records `signature_valid` via
  `HEIMDALL_SIGNING_PUBLIC_KEY`) — tamper-evidence only, per `§0.5`; never marketed as anti-cheat
- [ ] 22.4 Three-state UI per the kit: Ready (hardware + hotkey) → Capturing (timer, live trace,
  frame count) → Complete (smoothness tiles, "payload signed" note, upload & share / discard)
- [ ] 22.5 Upload through the existing ingest API (presigned Parquet PUT); signed-in via Clerk
  device flow or browser handoff; anonymous fallback keeps the management-token path
- [ ] 22.6 Real-capture fixture sweep: land real PresentMon (and CapFrameX-NVIDIA launch-wedge)
  exports and flip `SENSOR_AVAILABILITY` cells to `verified-real` via procedure 16a.1
- [ ] 22.7 Packaging: signed Windows installer, auto-update channel, crash reporting (opt-in)
- **Verify**: hotkey capture on a real game → shareable link in <10 s after stop; run page shows
  declared hardware + `signature_valid: true`
- **Regression**:
  - [ ] Rust unit tests: PresentMon spawn/stream/teardown, hotkey lifecycle, signing
  - [ ] Parser golden tests for any new real fixtures (hand-verified expected numbers)
  - [ ] Ingest e2e: signed desktop payload accepted; tampered payload records `signature_valid: false` **but is still accepted** (evidence, not gate)
  - [ ] CI builds the Tauri app on Windows runner

### Phase 9 Regression Gate
- Desktop capture → upload → report works end-to-end on Windows; CI green including Tauri build

---

## Phase 9.5: Desktop Capture — Linux / SteamOS (MangoHud watcher) — §23–§24

- [ ] 23.1 MangoHud log watcher mode (no injection of our own overlay): detect/tail MangoHud CSV,
  same parse → sign → upload pipeline (`§24.4` state parity with the Windows kit)
- [ ] 23.2 Mesa-aware hardware snapshot: on Linux AMD/Intel the "driver" is **Mesa/RADV/ANV** +
  kernel (per `docs/driver-currency-curation.md`) — report the Mesa version string MangoHud emits
- [ ] 24.1 Packaging: AppImage + Flatpak; SteamOS/Steam Deck notes (gaming mode constraints)
- [ ] 24.2 Real MangoHud fixture flips (NVIDIA/AMD/Intel cells; `gpu_vram_used` + `ram` unit
  assumptions confirmed)
- **Verify**: Deck/desktop-Linux capture uploads and diagnoses (driver-currency rules pick the
  Mesa baseline)
- **Regression**: watcher unit tests; Linux CI build; MangoHud golden fixtures

### Phase 9.5 Regression Gate
- Linux capture parity with Windows; both clients on the same ingest contract

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
- [ ] `HEIMDALL_SIGNING_PUBLIC_KEY` published once the desktop client ships (Phase 9)
- [ ] ClickHouse credentials (Phase 12)
