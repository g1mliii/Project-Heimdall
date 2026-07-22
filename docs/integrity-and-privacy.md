# Integrity & Privacy Posture

These are load-bearing product rules, not service defaults. They are written here as prose **and**
locked as code in [`packages/shared`](../packages/shared/src) so they can be tested and cannot
silently drift. Architecture rationale lives in [`PLAN.md`](../PLAN.md); the build order is in
[`IMPLEMENTATION_PLAN.md`](../IMPLEMENTATION_PLAN.md) (this doc covers §0.5 and §1.1–1.5).

## 1. Client signing is tamper-evidence, not a security wall (§0.5)

The desktop client signs upload payloads, but Heimdall is **open source** — a signing key shipped in
the binary can be extracted or recompiled. We therefore treat a signature as **tamper-evidence +
version-stamp + defense-in-depth only**, never as proof a capture is genuine.

- The API records `signature_valid` as **evidence**; it never gates acceptance on it.
- Trust comes from the server-side integrity layers below, not from the signature.
- We do **not** advertise signing as "prevents cheating."
- Optional future hardening (per-user keys, server-issued capture nonces) does not change this
  posture. See [`PLAN.md`](../PLAN.md) "Honest note on cryptographic signing."

## 2. Never trust the client; integrity is server-side

A run's public-facing numbers are **provisional** until a durable server job recomputes the summary
from the stored Parquet. The recomputed summary is canonical. The real anti-cheat is three layers:

1. **Telemetry-physics checks** — flag runs whose reported FPS is physically inconsistent with
   secondary sensors (GPU load / clock / power / VRAM). A check is **skipped, never failed,** when its
   required sensor is absent — we never flag on missing data.
2. **Statistical outlier rejection** (MAD/sigma) — hide implausible runs from public averages while
   keeping them visible to the owner. **Inert below the minimum-sample threshold** so a cold dataset
   never auto-hides legitimate runs.
3. **Verified-reviewer tier** — hardware-vetted reviewers (Phase 8).

Thresholds for layers 1–2 are named constants in
[`packages/shared/src/integrity.ts`](../packages/shared/src/integrity.ts).

## 3. Visibility model (§1.1)

| Visibility | Who can see it | Aggregate-eligible? |
|---|---|---|
| `private` | Owner only (a logged-out stranger gets a 404). Requires accounts (Phase 8). | No |
| `unlisted` | Anyone with the unguessable link. | **No** |
| `public` | Discoverable. | **Only once `status = validated`** |

A run feeds public aggregate pages (distributions) **only when it is both `public` and
`validated`** — enforced by `isAggregateEligible` / `aggregateEligibilitySql` in
[`packages/shared/src/visibility.ts`](../packages/shared/src/visibility.ts). Unlisted/private runs
stay out of distributions even when their direct URL is reachable.

> **Pre-auth note.** Accounts don't exist until Phase 8, so before then the default is `unlisted`
> (unguessable link) — there is no true owner-scoped `private` yet.

## 4. Anonymous management/delete tokens (§1.2)

Anonymous submission must always work. An anonymous uploader receives a one-time **plaintext**
management/delete token, shown **once**. The server persists **only its hash** — the plaintext is
never stored, so a database leak cannot be used to delete or manage runs.

- Implemented in [`packages/shared/src/tokens.ts`](../packages/shared/src/tokens.ts): generate
  (256-bit, URL-safe), `hashManagementToken` (SHA-256), and a **constant-time** `verifyManagementToken`.
- The token lets its holder delete their `unlisted`/`public` run **and the R2 objects** (Phase 8 §20.4).

## 5. Hardware-fingerprint privacy (§1.4)

A run carries a detailed hardware/software snapshot (GPU, CPU, RAM config, driver, OS, resolution,
sensor telemetry). In combination this is a **quasi-identifying hardware fingerprint** — it is
**not** "no personal data." We treat it accordingly:

- Surface it in the privacy policy as collected, quasi-identifying data (Phase 8 §20.4 / Phase 12).
- It is subject to the deletion / right-to-erasure path alongside the run.
- Aggregate pages group on **canonical** hardware/game ids (§4.4), never raw display strings.

## 6. Account erasure and delivery replay fence (§20.4)

Account deletion is a durable, bounded job: it first prevents new owned writes,
then removes R2 objects, run rows, and finally the account row. This ordering
prevents the users-to-runs foreign key from cascading a run row before its
quasi-identifying frame data has been removed.

- To prevent a delayed browser session or an out-of-order Clerk profile webhook
  from recreating an erased account, we retain one one-way, domain-separated
  SHA-256 value derived from the Clerk id. We do **not** retain the raw Clerk id,
  handle, email, role, runs, or hardware snapshot for this purpose.
- Svix event identifiers are deduplicated, retained for 30 days, then pruned in
  bounded maintenance batches. They are delivery state, not an audit log.
- The irreversible fence is limited to suppressing replay of a deleted account;
  it is never surfaced in the product or used for profiling/analytics.

## 7. Encryption posture (§1.5)

- **In transit:** HTTPS everywhere — uploads (direct-to-R2 presigned PUT), API, and dashboard.
- **At rest:** encryption via **Neon** (Postgres) and **Cloudflare R2** platform defaults.
- This is a **guardrail, not just a default** — at-rest encryption must never be disabled when
  provisioning or reconfiguring those services. Verify it stays on as part of any infra change.
