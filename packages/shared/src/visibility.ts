/**
 * Run visibility & lifecycle status — the load-bearing privacy/integrity rules,
 * locked as code (IMPLEMENTATION_PLAN §1.1). Narrative: docs/integrity-and-privacy.md.
 *
 * Phase 1 (§2.1) builds the full domain model around these primitives; keep the
 * source-of-truth for "what may be aggregated" here so no query can drift.
 */

/** Where a run can be seen. */
export const RUN_VISIBILITY = {
  /** Owner-only. A logged-out stranger gets a 404. Requires accounts (Phase 8). */
  private: "private",
  /** Reachable only via an unguessable link. Never feeds public aggregates. */
  unlisted: "unlisted",
  /** Discoverable; eligible for aggregate pages once `validated`. */
  public: "public",
} as const;

export type RunVisibility = (typeof RUN_VISIBILITY)[keyof typeof RUN_VISIBILITY];

/** Server-side verification lifecycle (§18.3). */
export const RUN_STATUS = {
  /** Uploaded; the client's numbers are provisional until the server recompute. */
  pending: "pending",
  /** Server recompute passed. Canonical for public stats. */
  validated: "validated",
  /** Failed a reproducible server-integrity check; visible to its owner, excluded from aggregates. */
  flagged: "flagged",
  /**
   * The deletion tombstone (§12.6/§20.2/§20.4) — set immediately before the
   * frames object is deleted from R2, so a reader can never be handed a run
   * pointing at storage that is mid-delete. Invisible to EVERYONE including
   * the owner (`isVisibleTo` in `lib/repo/runs.ts`) — distinct from
   * `moderated`, which the owner still sees, labeled.
   */
  hidden: "hidden",
  /**
   * Moderator-hidden content (§20.5) — distinct from owner-set `private`,
   * integrity-`flagged`, and the deletion tombstone `hidden`. The owner still
   * sees their own run, labeled as moderated; a stranger gets the same 404 as
   * `private`/`flagged`/`hidden`/missing. Never aggregate-eligible (only
   * `validated` pools — no change needed to that guard).
   */
  moderated: "moderated",
} as const;

export type RunStatus = (typeof RUN_STATUS)[keyof typeof RUN_STATUS];

/**
 * A run feeds public aggregate pages (distributions) ONLY when it is both
 * `public` AND `validated`. Unlisted/private or pending/flagged/hidden runs are
 * never aggregated, even when their direct URL is reachable.
 * (IMPLEMENTATION_PLAN §1.1, §4.5, §17.3.)
 */
export function isAggregateEligible(input: {
  visibility: RunVisibility;
  status: RunStatus;
}): boolean {
  return input.visibility === RUN_VISIBILITY.public && input.status === RUN_STATUS.validated;
}

/**
 * The canonical SQL predicate for aggregate-eligible runs, so every distribution
 * query shares one guard and none can drift. `alias` is a trusted table alias
 * (developer-supplied, never user input); the compared values are our own enum
 * literals, so there is no injection surface.
 */
export function aggregateEligibilitySql(alias = "runs"): string {
  return `${alias}.visibility = '${RUN_VISIBILITY.public}' AND ${alias}.status = '${RUN_STATUS.validated}'`;
}

/**
 * Terminal run states — a deletion tombstone (`hidden`) or a §20.5 moderation
 * takedown (`moderated`). Both outrank any later verdict, so every write path
 * (verification, reprocess, driver refresh, moderation) refuses to touch a run
 * in one. Naming the family here rather than spelling the pair per query means
 * a sixth status is one edit, not a sweep — and a missed site can't silently
 * resurrect a moderated run.
 */
export const RUN_TERMINAL_STATUSES = [RUN_STATUS.hidden, RUN_STATUS.moderated] as const;

/**
 * The SQL half of {@link RUN_TERMINAL_STATUSES}: "this run may still be
 * written to". `column` is a trusted developer-supplied identifier, never user
 * input, and the compared values are our own enum literals — same posture as
 * {@link aggregateEligibilitySql}.
 */
export function writableRunStatusSql(column = "status"): string {
  const statuses = RUN_TERMINAL_STATUSES.map((status) => `'${status}'`).join(", ");
  return `${column} not in (${statuses})`;
}

/**
 * Roles that carry the §20.3 verified-reviewer trust marker. `admin`
 * supersedes `verified` (see lib/repo/verifications.ts — role is one
 * three-state enum, not independent flags), so an admin's own submissions are
 * verified submissions.
 *
 * Marker/filter only: this decides who gets the shield-check badge and who
 * survives the "Verified only" toggle. It NEVER touches the aggregate math,
 * and it is not a substitute for `isAggregateEligible` — a verified
 * reviewer's private or pending run still pools nowhere.
 */
const VERIFIED_REVIEWER_ROLES = ["verified", "admin"] as const;

export function isVerifiedReviewer(role: string | null | undefined): boolean {
  return VERIFIED_REVIEWER_ROLES.some((verified) => verified === role);
}

/**
 * The SQL half of `isVerifiedReviewer`, so a query and a row mapper can never
 * disagree about who is verified. `alias` is a trusted table alias
 * (developer-supplied, never user input); the compared values are our own
 * enum literals, so there is no injection surface — same posture as
 * `aggregateEligibilitySql`.
 */
export function verifiedReviewerSql(alias = "users"): string {
  const roles = VERIFIED_REVIEWER_ROLES.map((role) => `'${role}'`).join(", ");
  return `${alias}.role in (${roles})`;
}
