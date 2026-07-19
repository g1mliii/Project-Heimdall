/**
 * Job-drain loop + housekeeping (§11.5/§11.11). One entry point, two callers:
 * the secret-guarded POST /api/internal/jobs/drain route (platform cron) and
 * the scripts/drain-jobs.ts CLI. Durability lives in the DB rows — a drain
 * pass dying mid-flight loses nothing (stale `running` locks get reaped).
 */

import { INGEST_LIMITS } from "@heimdall/shared";
import { MAX_OBJECT_READ_BYTES, deleteObject, framesUploadObjectKey, getObject } from "../r2";
import { getIngestEnv } from "../env";
import { getPool, type Queryable } from "../db";
import {
  claimNextVerificationJob,
  completeVerificationJob,
  failVerificationJob,
} from "../repo/jobs";
import {
  claimNextReprocessJob,
  completeReprocessJob,
  enqueueDriverRefreshJobs,
  failReprocessJob,
  REPROCESS_KIND,
  type ClaimedReprocessJob,
  type ReprocessKind,
} from "../repo/reprocess";
import { pruneRateLimits } from "../repo/rate-limit";
import {
  completeStagingCleanupJob,
  claimNextStagingCleanupJob,
  deletePendingRun,
  readStalePendingRuns,
  retryStagingCleanupJob,
} from "../repo/runs";
import {
  claimNextCohortAssessmentJob,
  completeCohortAssessmentJob,
  enqueueStaleCohortAssessments,
  failCohortAssessmentJob,
  recomputeGameCohortAssessments,
} from "../integrity/cohort-assessment";
import { verifyRunJob, type VerifyDeps } from "./verify-run";
import { refreshDriverFindingsJob } from "./reprocess-run";

/** A job claimed this many times without finishing is dead — stop retrying. */
export const MAX_VERIFICATION_ATTEMPTS = 5;
export const MAX_REPROCESS_ATTEMPTS = 5;
export const MAX_COHORT_ASSESSMENT_ATTEMPTS = 5;

export interface DrainResult {
  claimed: number;
  validated: number;
  flagged: number;
  retried: number;
  failed: number;
}

export interface ReprocessDrainResult {
  driverEnqueued: number;
  reprocessClaimed: number;
  reprocessed: number;
  reprocessSummaryDrifted: number;
  driverRefreshed: number;
  driverFindingsChanged: number;
  reprocessRetried: number;
  reprocessFailed: number;
}

/** A pass that did no work. Counters start here and a skipped pass returns it. */
function emptyDrainResult(): DrainResult {
  return { claimed: 0, validated: 0, flagged: 0, retried: 0, failed: 0 };
}

/** @see emptyDrainResult */
function emptyReprocessDrainResult(): ReprocessDrainResult {
  return {
    driverEnqueued: 0,
    reprocessClaimed: 0,
    reprocessed: 0,
    reprocessSummaryDrifted: 0,
    driverRefreshed: 0,
    driverFindingsChanged: 0,
    reprocessRetried: 0,
    reprocessFailed: 0,
  };
}

export interface DrainDeps extends VerifyDeps {
  deleteObject(key: string): Promise<void>;
}

function realDeps(): DrainDeps {
  return {
    db: getPool(),
    getObject: (key) => getObject(key, { maxBytes: MAX_OBJECT_READ_BYTES }),
    deleteObject,
    publicKeyBase64: getIngestEnv().HEIMDALL_SIGNING_PUBLIC_KEY,
  };
}

function realMaintenanceDeps(): Pick<DrainDeps, "db" | "deleteObject"> {
  return { db: getPool(), deleteObject };
}

function hasTimeRemaining(deadlineAt?: number): boolean {
  return deadlineAt === undefined || Date.now() < deadlineAt;
}

export async function drainJobs(
  {
    maxJobs = 10,
    budgetMs = 25_000,
    deadlineAt,
  }: { maxJobs?: number; budgetMs?: number; deadlineAt?: number } = {},
  deps: DrainDeps = realDeps(),
): Promise<DrainResult> {
  const deadline = deadlineAt ?? Date.now() + budgetMs;
  const result: DrainResult = emptyDrainResult();
  const attemptedThisPass = new Set<string>();

  while (result.claimed < maxJobs && Date.now() < deadline) {
    // Jobs this pass already retried are excluded from the claim — retry
    // belongs to a LATER pass, but one transiently failing job at the head
    // of the queue must not starve every younger job behind it.
    const job = await claimNextVerificationJob({ excludeIds: [...attemptedThisPass] }, deps.db);
    if (!job) {
      break;
    }
    attemptedThisPass.add(job.id);
    result.claimed += 1;

    if (job.attempts > MAX_VERIFICATION_ATTEMPTS) {
      await failVerificationJob(job.id, job.attempts, "attempts cap exceeded", true, deps.db);
      result.failed += 1;
      continue;
    }

    const outcome = await verifyRunJob(job, deps);
    switch (outcome.kind) {
      case "validated":
        await completeVerificationJob(job.id, job.attempts, deps.db);
        result.validated += 1;
        break;
      case "flagged":
        // The job itself SUCCEEDED — it produced a canonical verdict; the
        // run's flagged status is the verdict, not a job failure.
        await completeVerificationJob(job.id, job.attempts, deps.db);
        result.flagged += 1;
        break;
      case "retry": {
        const terminal = job.attempts >= MAX_VERIFICATION_ATTEMPTS;
        await failVerificationJob(job.id, job.attempts, outcome.error, terminal, deps.db);
        if (terminal) {
          result.failed += 1;
        } else {
          result.retried += 1;
        }
        break;
      }
      case "failed":
        await failVerificationJob(job.id, job.attempts, outcome.error, true, deps.db);
        result.failed += 1;
        break;
    }
  }
  return result;
}

/** A fifth, independently bounded lane; it can never consume live-ingest job slots. */
export async function drainReprocessJobs(
  {
    maxJobs = 2,
    budgetMs = 25_000,
    deadlineAt,
  }: {
    maxJobs?: number;
    budgetMs?: number;
    deadlineAt?: number;
  } = {},
  deps: Pick<DrainDeps, "db" | "getObject" | "publicKeyBase64"> = realDeps(),
): Promise<ReprocessDrainResult> {
  const deadline = deadlineAt ?? Date.now() + budgetMs;
  const result: ReprocessDrainResult = emptyReprocessDrainResult();
  const jobLimit = Math.max(0, Math.floor(maxJobs));
  if (!hasTimeRemaining(deadline) || jobLimit === 0) return result;

  // The alternating claim order can drain at most half the pass as driver
  // work when full replays are also backlogged. Keep the live driver queue at
  // that capacity so a large catalog update cannot grow it faster than cron
  // consumes it.
  const driverQueueCapacity = Math.ceil(jobLimit / 2);
  result.driverEnqueued = (
    await enqueueDriverRefreshJobs({ limit: driverQueueCapacity }, deps.db)
  ).enqueued;
  const attemptedThisPass = new Set<string>();

  while (result.reprocessClaimed < jobLimit && hasTimeRemaining(deadline)) {
    // Alternate the preferred kind. A mass full backfill cannot starve weekly
    // driver work, and continuous driver churn cannot monopolize the lane.
    const preferred: readonly ReprocessKind[] =
      result.reprocessClaimed % 2 === 0
        ? [REPROCESS_KIND.driver, REPROCESS_KIND.full]
        : [REPROCESS_KIND.full, REPROCESS_KIND.driver];
    let job: ClaimedReprocessJob | null = null;
    for (const kind of preferred) {
      job = await claimNextReprocessJob(
        kind,
        { excludeKeys: [...attemptedThisPass] },
        deps.db,
      );
      if (job !== null) break;
    }
    if (job === null) break;

    attemptedThisPass.add(job.key);
    result.reprocessClaimed += 1;
    if (job.attempts > MAX_REPROCESS_ATTEMPTS) {
      await failReprocessJob(job, "attempts cap exceeded", true, deps.db);
      result.reprocessFailed += 1;
      continue;
    }

    try {
      if (job.kind === REPROCESS_KIND.driver) {
        const outcome = await refreshDriverFindingsJob(job, deps.db);
        if (outcome.kind === "failed") {
          await failReprocessJob(job, outcome.error, true, deps.db);
          result.reprocessFailed += 1;
          continue;
        }
        await completeReprocessJob(job, deps.db);
        result.driverRefreshed += 1;
        if (outcome.changed) result.driverFindingsChanged += 1;
        continue;
      }

      const outcome = await verifyRunJob(job, deps, { mode: "reprocess" });
      if (outcome.kind === "reprocessed") {
        await completeReprocessJob(job, deps.db);
        result.reprocessed += 1;
        if (outcome.summaryDrift !== null) result.reprocessSummaryDrifted += 1;
        continue;
      }
      if (outcome.kind === "retry") {
        const terminal = job.attempts >= MAX_REPROCESS_ATTEMPTS;
        await failReprocessJob(job, outcome.error, terminal, deps.db);
        if (terminal) result.reprocessFailed += 1;
        else result.reprocessRetried += 1;
        continue;
      }
      await failReprocessJob(
        job,
        outcome.kind === "failed" ? outcome.error : `unexpected ${outcome.kind} outcome`,
        true,
        deps.db,
      );
      result.reprocessFailed += 1;
    } catch (error) {
      const terminal = job.attempts >= MAX_REPROCESS_ATTEMPTS;
      await failReprocessJob(job, String(error), terminal, deps.db);
      if (terminal) result.reprocessFailed += 1;
      else result.reprocessRetried += 1;
    }
  }
  return result;
}

/**
 * §11.11 TTL reaper: stale never-finalized runs are deleted, along with any
 * uploaded-but-unfinalized R2 object (the key is deterministic, so we delete
 * blind — R2 deletes of missing keys are no-ops).
 */
export async function cleanupStalePending(
  deps: Pick<DrainDeps, "db" | "deleteObject"> = realMaintenanceDeps(),
  { limit = 100, deadlineAt }: { limit?: number; deadlineAt?: number } = {},
): Promise<number> {
  const db: Queryable = deps.db;
  if (!hasTimeRemaining(deadlineAt)) {
    return 0;
  }
  const staleIds = await readStalePendingRuns(INGEST_LIMITS.stalePendingTtlHours, limit, db);
  let cleaned = 0;
  for (const id of staleIds) {
    if (!hasTimeRemaining(deadlineAt)) {
      break;
    }
    try {
      await deps.deleteObject(framesUploadObjectKey(id));
    } catch (error) {
      // Keep the row: it is the durable pointer that lets a later pass retry
      // the staging-object deletion instead of orphaning storage forever.
      console.error(`stale-pending cleanup: object delete failed for ${id}`, error);
      continue;
    }
    if (await deletePendingRun(id, db)) {
      cleaned += 1;
    }
  }
  return cleaned;
}

/**
 * Reap finalized runs' browser-writable staging keys after their PUT URLs
 * expire. The DB queue intentionally survives run deletion so a late PUT is
 * still discoverable; failed storage deletes stay queued with backoff.
 */
export async function cleanupFinalizedStaging(
  deps: Pick<DrainDeps, "db" | "deleteObject"> = realMaintenanceDeps(),
  { limit = 100, deadlineAt }: { limit?: number; deadlineAt?: number } = {},
): Promise<number> {
  const db: Queryable = deps.db;
  let cleaned = 0;
  let claimed = 0;
  while (claimed < limit && hasTimeRemaining(deadlineAt)) {
    const job = await claimNextStagingCleanupJob({}, db);
    if (!job) {
      break;
    }
    claimed += 1;
    try {
      await deps.deleteObject(job.objectKey);
    } catch (error) {
      await retryStagingCleanupJob(job.runId, job.attempts, String(error), db);
      console.error(`finalized staging cleanup: object delete failed for ${job.runId}`, error);
      continue;
    }
    if (await completeStagingCleanupJob(job.runId, job.attempts, db)) {
      cleaned += 1;
    }
  }
  return cleaned;
}

export interface CohortAssessmentDrainResult {
  /** Games enqueued for reassessment this pass (stale/new observations). */
  cohortAssessmentsEnqueued: number;
  /** Games whose cohort assessment was recomputed. */
  cohortAssessmentsRecomputed: number;
  /** Games whose recompute failed terminally and is now tombstoned. */
  cohortAssessmentsFailed: number;
  /** Games whose recompute threw but will retry after a backoff. */
  cohortAssessmentsRetried: number;
}

function emptyCohortAssessmentDrainResult(): CohortAssessmentDrainResult {
  return {
    cohortAssessmentsEnqueued: 0,
    cohortAssessmentsRecomputed: 0,
    cohortAssessmentsFailed: 0,
    cohortAssessmentsRetried: 0,
  };
}

/**
 * §18.5 bounded recalculation lane: enqueue games whose cohort assessment is
 * stale, then recompute a bounded number of them. Purely a background audit
 * refresh — the distribution read excludes outliers live regardless — so it
 * runs last and yields the moment the pass budget is spent.
 */
export async function drainCohortAssessments(
  { maxGames = 5, deadlineAt }: { maxGames?: number; deadlineAt?: number } = {},
  deps: DrainDeps = realDeps(),
): Promise<CohortAssessmentDrainResult> {
  const result = emptyCohortAssessmentDrainResult();
  if (!hasTimeRemaining(deadlineAt) || maxGames === 0) return result;

  try {
    result.cohortAssessmentsEnqueued = await enqueueStaleCohortAssessments(
      { limit: maxGames * 20 },
      deps.db,
    );
  } catch (error) {
    // A failed enqueue must not stop the pass from draining work already queued.
    console.error("cohort assessment enqueue failed", error);
  }

  let attempted = 0;
  while (attempted < maxGames && hasTimeRemaining(deadlineAt)) {
    const job = await claimNextCohortAssessmentJob({}, deps.db);
    if (!job) break;
    attempted += 1;

    if (job.attempts > MAX_COHORT_ASSESSMENT_ATTEMPTS) {
      await failCohortAssessmentJob(job, "attempts cap exceeded", true, deps.db);
      result.cohortAssessmentsFailed += 1;
      continue;
    }

    try {
      await recomputeGameCohortAssessments(job.gameId, deps.db);
      await completeCohortAssessmentJob(job, deps.db);
      result.cohortAssessmentsRecomputed += 1;
    } catch (error) {
      // This lane is a background audit refresh; the distribution read excludes
      // outliers live regardless. One game's failed recompute must never reject
      // the maintenance pass and stall verification site-wide — so record the
      // failure and move on. Past the attempts cap it becomes a tombstone, which
      // keeps a permanently broken game from consuming a slot on every pass.
      const terminal = job.attempts >= MAX_COHORT_ASSESSMENT_ATTEMPTS;
      console.error(`cohort assessment recompute failed for game ${job.gameId}`, error);
      await failCohortAssessmentJob(job, String(error), terminal, deps.db);
      if (terminal) result.cohortAssessmentsFailed += 1;
      else result.cohortAssessmentsRetried += 1;
    }
  }
  return result;
}

export interface MaintenancePassResult
  extends DrainResult,
    ReprocessDrainResult,
    CohortAssessmentDrainResult {
  cleanedStalePending: number;
  cleanedFinalizedStaging: number;
  prunedRateLimitWindows: number;
}

/** Keep cleanup queues moving even when verification work is continuously backlogged. */
const MAINTENANCE_RESERVE_MS = 5_000;
const REPROCESS_MAX_JOBS_PER_PASS = 2;
const COHORT_ASSESSMENT_MAX_GAMES_PER_PASS = 5;

/**
 * The full §11.5/§11.11 housekeeping pass — drain jobs, reap stale and
 * finalized staging objects, and prune rate-limit windows. Both entry points
 * (the cron route and the CLI) call this definition, so a step added here can
 * never silently run in only one deployment mode.
 */
export async function runMaintenancePass(
  opts: { maxJobs?: number; budgetMs?: number } = {},
  deps: DrainDeps = realDeps(),
): Promise<MaintenancePassResult> {
  const { maxJobs = 10, budgetMs = 25_000 } = opts;
  const deadlineAt = Date.now() + budgetMs;
  // Verification can use the bulk of a pass, but it must not consume all of
  // it: otherwise a sustained ingest backlog starves staging-object cleanup
  // and rate-limit pruning indefinitely.
  const maintenanceReserveMs = Math.min(MAINTENANCE_RESERVE_MS, Math.ceil(budgetMs / 2));
  // Start every durable lane immediately. Deadline checks prevent cleanup from
  // expanding without bound, while concurrent lanes mean a slow R2/Parquet
  // verification cannot delay cleanup until after its own deadline.
  let drained: DrainResult;
  let cleanedStalePending: number;
  let cleanedFinalizedStaging: number;
  let prunedRateLimitWindows: number;
  let reprocessed: ReprocessDrainResult;
  let cohortAssessed: CohortAssessmentDrainResult;
  if (hasTimeRemaining(deadlineAt)) {
    [
      drained,
      cleanedStalePending,
      cleanedFinalizedStaging,
      prunedRateLimitWindows,
      reprocessed,
      cohortAssessed,
    ] = await Promise.all([
      drainJobs({ maxJobs, deadlineAt: deadlineAt - maintenanceReserveMs }, deps),
      cleanupStalePending(deps, { deadlineAt }),
      cleanupFinalizedStaging(deps, { deadlineAt }),
      pruneRateLimits(deps.db),
      drainReprocessJobs(
        { maxJobs: REPROCESS_MAX_JOBS_PER_PASS, deadlineAt: deadlineAt - maintenanceReserveMs },
        deps,
      ),
      drainCohortAssessments(
        {
          maxGames: COHORT_ASSESSMENT_MAX_GAMES_PER_PASS,
          deadlineAt: deadlineAt - maintenanceReserveMs,
        },
        deps,
      ),
    ]);
  } else {
    drained = emptyDrainResult();
    cleanedStalePending = 0;
    cleanedFinalizedStaging = 0;
    prunedRateLimitWindows = 0;
    reprocessed = emptyReprocessDrainResult();
    cohortAssessed = emptyCohortAssessmentDrainResult();
  }
  return {
    ...drained,
    ...reprocessed,
    ...cohortAssessed,
    cleanedStalePending,
    cleanedFinalizedStaging,
    prunedRateLimitWindows,
  };
}
