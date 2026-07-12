import { describe, expect, it, vi } from "vitest";
import type { Queryable } from "../db";
import { drainJobs, runMaintenancePass, type DrainDeps } from "./drain";

describe("drainJobs budget", () => {
  it("does not claim work once its explicit deadline has elapsed", async () => {
    const db = { query: vi.fn() } as unknown as Queryable;
    const deps: DrainDeps = {
      db,
      getObject: vi.fn(),
      deleteObject: vi.fn(),
    };

    await expect(drainJobs({ deadlineAt: Date.now() - 1 }, deps)).resolves.toEqual({
      claimed: 0,
      validated: 0,
      flagged: 0,
      retried: 0,
      failed: 0,
    });
    expect(db.query).not.toHaveBeenCalled();
  });
});

describe("runMaintenancePass", () => {
  it("starts cleanup lanes while a verification claim is still in flight", async () => {
    let resolveClaim: ((value: { rows: never[] }) => void) | undefined;
    const query = vi.fn((text: string) => {
      if (text.includes("update verification_jobs vj")) {
        return new Promise<{ rows: never[] }>((resolve) => {
          resolveClaim = resolve;
        });
      }
      return Promise.resolve({ rows: [], rowCount: 0 });
    });
    const db = { query } as unknown as Queryable;
    const deps: DrainDeps = { db, getObject: vi.fn(), deleteObject: vi.fn() };

    const pass = runMaintenancePass({ budgetMs: 1_000 }, deps);
    await Promise.resolve();
    await Promise.resolve();

    expect(query.mock.calls.some(([text]) => String(text).includes("from runs"))).toBe(true);
    expect(query.mock.calls.some(([text]) => String(text).includes("staging_cleanup_jobs"))).toBe(true);
    expect(query.mock.calls.some(([text]) => String(text).includes("delete from rate_limits"))).toBe(true);

    resolveClaim?.({ rows: [] });
    await expect(pass).resolves.toMatchObject({
      claimed: 0,
      cleanedStalePending: 0,
      cleanedFinalizedStaging: 0,
      prunedRateLimitWindows: 0,
    });
  });
});
