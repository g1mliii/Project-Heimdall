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
  /** Removed from public view by moderation/takedown. */
  hidden: "hidden",
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
