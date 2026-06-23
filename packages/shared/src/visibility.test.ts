import { describe, expect, it } from "vitest";

import {
  RUN_STATUS,
  RUN_VISIBILITY,
  aggregateEligibilitySql,
  isAggregateEligible,
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
