/**
 * §18.5 cohort-assessment lane isolation. This lane is a background audit
 * refresh — the distribution read excludes outliers live regardless — so one
 * game's failing recompute must never reject `runMaintenancePass`'s Promise.all
 * and stall verification, cleanup, and rate-limit pruning site-wide.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const claimNextCohortAssessmentJob = vi.fn();
const completeCohortAssessmentJob = vi.fn();
const failCohortAssessmentJob = vi.fn();
const recomputeGameCohortAssessments = vi.fn();
const enqueueStaleCohortAssessments = vi.fn();

vi.mock("../integrity/cohort-assessment", () => ({
  claimNextCohortAssessmentJob: (...args: unknown[]) => claimNextCohortAssessmentJob(...args),
  completeCohortAssessmentJob: (...args: unknown[]) => completeCohortAssessmentJob(...args),
  failCohortAssessmentJob: (...args: unknown[]) => failCohortAssessmentJob(...args),
  recomputeGameCohortAssessments: (...args: unknown[]) => recomputeGameCohortAssessments(...args),
  enqueueStaleCohortAssessments: (...args: unknown[]) => enqueueStaleCohortAssessments(...args),
}));

const { drainCohortAssessments, MAX_COHORT_ASSESSMENT_ATTEMPTS } = await import("./drain");

/** Only `db` is reached on this path; the lane never touches R2. */
const deps = { db: {}, deleteObject: async () => undefined } as never;

/** Queue `gameIds` in order (each a first claim), then run dry. */
function queue(gameIds: string[]) {
  let index = 0;
  claimNextCohortAssessmentJob.mockImplementation(() =>
    Promise.resolve(
      index < gameIds.length
        ? { gameId: gameIds[index++], attempts: 1, enqueueGeneration: 0 }
        : null,
    ),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  enqueueStaleCohortAssessments.mockResolvedValue(0);
  completeCohortAssessmentJob.mockResolvedValue(true);
  failCohortAssessmentJob.mockResolvedValue(true);
});

describe("drainCohortAssessments (§18.5)", () => {
  it("keeps draining after one game's recompute throws", async () => {
    queue(["game-a", "game-b", "game-c"]);
    recomputeGameCohortAssessments.mockImplementation((gameId: string) =>
      gameId === "game-b"
        ? Promise.reject(new Error("statement timeout"))
        : Promise.resolve({ assessed: 3, excluded: 0 }),
    );

    const result = await drainCohortAssessments({ maxGames: 5 }, deps);

    // The pass survives, the healthy games still got recomputed, and the
    // failure is recorded rather than swallowed silently.
    expect(result.cohortAssessmentsRecomputed).toBe(2);
    expect(result.cohortAssessmentsRetried).toBe(1);
    expect(result.cohortAssessmentsFailed).toBe(0);
    // The failed game is NOT completed — it is failed with a backoff instead,
    // non-terminally, so a later pass retries it.
    expect(completeCohortAssessmentJob).not.toHaveBeenCalledWith(
      expect.objectContaining({ gameId: "game-b" }),
      expect.anything(),
    );
    expect(failCohortAssessmentJob).toHaveBeenCalledWith(
      expect.objectContaining({ gameId: "game-b" }),
      expect.stringContaining("statement timeout"),
      false,
      expect.anything(),
    );
  });

  it("counts a failing game against the pass budget so it cannot spin", async () => {
    claimNextCohortAssessmentJob.mockResolvedValue({
      gameId: "always-broken",
      attempts: 1,
      enqueueGeneration: 0,
    });
    recomputeGameCohortAssessments.mockRejectedValue(new Error("boom"));

    const result = await drainCohortAssessments({ maxGames: 3 }, deps);

    expect(result.cohortAssessmentsRetried).toBe(3);
    expect(claimNextCohortAssessmentJob).toHaveBeenCalledTimes(3);
  });

  it("tombstones a game that keeps failing, so it stops consuming a slot", async () => {
    // The claim that reaches the cap: this failure must be terminal.
    claimNextCohortAssessmentJob.mockResolvedValue({
      gameId: "always-broken",
      attempts: MAX_COHORT_ASSESSMENT_ATTEMPTS,
      enqueueGeneration: 0,
    });
    recomputeGameCohortAssessments.mockRejectedValue(new Error("boom"));

    const result = await drainCohortAssessments({ maxGames: 1 }, deps);

    expect(result.cohortAssessmentsFailed).toBe(1);
    expect(result.cohortAssessmentsRetried).toBe(0);
    expect(failCohortAssessmentJob).toHaveBeenCalledWith(
      expect.objectContaining({ gameId: "always-broken" }),
      expect.stringContaining("boom"),
      true,
      expect.anything(),
    );
  });

  it("gives up without recomputing once a claim exceeds the attempts cap", async () => {
    claimNextCohortAssessmentJob.mockResolvedValue({
      gameId: "wedged",
      attempts: MAX_COHORT_ASSESSMENT_ATTEMPTS + 1,
      enqueueGeneration: 0,
    });

    const result = await drainCohortAssessments({ maxGames: 1 }, deps);

    // Past the cap the lane must not even attempt the recompute — the point is
    // to stop paying for a job that has already proven it cannot finish.
    expect(recomputeGameCohortAssessments).not.toHaveBeenCalled();
    expect(result.cohortAssessmentsFailed).toBe(1);
    expect(failCohortAssessmentJob).toHaveBeenCalledWith(
      expect.objectContaining({ gameId: "wedged" }),
      "attempts cap exceeded",
      true,
      expect.anything(),
    );
  });

  it("still drains queued work when the enqueue step fails", async () => {
    enqueueStaleCohortAssessments.mockRejectedValue(new Error("enqueue exploded"));
    queue(["game-a"]);
    recomputeGameCohortAssessments.mockResolvedValue({ assessed: 1, excluded: 0 });

    const result = await drainCohortAssessments({ maxGames: 5 }, deps);

    expect(result.cohortAssessmentsEnqueued).toBe(0);
    expect(result.cohortAssessmentsRecomputed).toBe(1);
  });
});
