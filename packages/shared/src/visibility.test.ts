import { describe, expect, it } from "vitest";

import {
  RUN_STATUS,
  RUN_VISIBILITY,
  aggregateEligibilitySql,
  isAggregateEligible,
  isVerifiedReviewer,
  RUN_TERMINAL_STATUSES,
  verifiedReviewerSql,
  writableRunStatusSql,
} from "./visibility";

describe("isAggregateEligible", () => {
  it("admits only public + validated runs", () => {
    expect(
      isAggregateEligible({ visibility: RUN_VISIBILITY.public, status: RUN_STATUS.validated }),
    ).toBe(true);
  });

  it("rejects unlisted/private runs even when validated", () => {
    for (const visibility of [RUN_VISIBILITY.unlisted, RUN_VISIBILITY.private] as const) {
      expect(isAggregateEligible({ visibility, status: RUN_STATUS.validated })).toBe(false);
    }
  });

  it("rejects public runs that are not validated", () => {
    for (const status of [RUN_STATUS.pending, RUN_STATUS.flagged, RUN_STATUS.hidden] as const) {
      expect(isAggregateEligible({ visibility: RUN_VISIBILITY.public, status })).toBe(false);
    }
  });
});

describe("aggregateEligibilitySql", () => {
  it("guards on both public visibility and validated status", () => {
    const sql = aggregateEligibilitySql("r");
    expect(sql).toBe("r.visibility = 'public' AND r.status = 'validated'");
  });

  it("defaults the table alias to runs", () => {
    expect(aggregateEligibilitySql()).toContain("runs.visibility");
  });
});

describe("verified-reviewer tier (§20.3)", () => {
  it("counts admin as verified — admin trust supersedes the verified tier", () => {
    expect(isVerifiedReviewer("verified")).toBe(true);
    expect(isVerifiedReviewer("admin")).toBe(true);
  });

  it("rejects the base role and an absent one", () => {
    expect(isVerifiedReviewer("public")).toBe(false);
    expect(isVerifiedReviewer(null)).toBe(false);
    expect(isVerifiedReviewer(undefined)).toBe(false);
  });

  it("keeps the SQL predicate in lockstep with the TS one", () => {
    // These two decide who gets the shield-check badge and who survives the
    // "Verified only" toggle. When they disagreed, an admin's badged run
    // disappeared the moment the toggle went on.
    const sql = verifiedReviewerSql("u");
    expect(sql).toBe("u.role in ('verified', 'admin')");
    for (const role of ["public", "verified", "admin"]) {
      expect(sql.includes(`'${role}'`)).toBe(isVerifiedReviewer(role));
    }
  });

  it("defaults the table alias to users", () => {
    expect(verifiedReviewerSql()).toContain("users.role");
  });
});

describe("terminal run statuses (§20.5)", () => {
  it("covers exactly the two states no write path may overwrite", () => {
    // A deletion tombstone and a moderation takedown both outrank a late
    // verification verdict. Adding a status to RUN_STATUS must be a deliberate
    // decision about this set, not a silent omission from it.
    expect([...RUN_TERMINAL_STATUSES]).toEqual([RUN_STATUS.hidden, RUN_STATUS.moderated]);
  });

  it("keeps the SQL predicate in lockstep with the constant", () => {
    const sql = writableRunStatusSql();
    expect(sql).toBe("status not in ('hidden', 'moderated')");
    for (const status of Object.values(RUN_STATUS)) {
      const terminal = (RUN_TERMINAL_STATUSES as readonly string[]).includes(status);
      expect(sql.includes(`'${status}'`)).toBe(terminal);
    }
  });

  it("accepts a qualified column for multi-table statements", () => {
    expect(writableRunStatusSql("runs.status")).toContain("runs.status not in");
  });
});
