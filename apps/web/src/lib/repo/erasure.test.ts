/**
 * Account erasure coverage (§20.4). Real Postgres via the shared harness;
 * R2 is module-mocked (same convention as app/api/runs/api.test.ts) — the
 * ordering this test protects is R2-delete-before-row-delete, user-row-last,
 * and idempotency, not R2 client behavior itself.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { RUN_STATUS, RUN_VISIBILITY, validRun } from "@heimdall/shared";
import type { Run } from "@heimdall/shared";
import { insertRun, readRun, RunOwnerUnavailableError } from "../db";
import { createTestDb, testDbAvailable, type TestDb } from "../testing/test-db";
import { finalizeRun } from "./runs";
import { AccountErasedError, ensureUser } from "./users";

vi.mock("../r2", () => ({
  deleteObject: vi.fn(async () => {}),
  framesUploadObjectKey: (runId: string) => `staging/runs/${runId}.parquet`,
}));
import { deleteObject } from "../r2";

const canRun = testDbAvailable("erasure.test");

function pendingRun(id: string, userId: string): Run {
  return {
    ...validRun,
    id,
    status: RUN_STATUS.pending,
    visibility: RUN_VISIBILITY.unlisted,
    framesObjectKey: undefined,
    signatureValid: undefined,
    ownerId: userId,
  };
}

describe.skipIf(!canRun)("account erasure (§20.4)", () => {
  let db: TestDb;
  let enqueueUserErasure: typeof import("./erasure").enqueueUserErasure;
  let enqueueUserErasureFromClerk: typeof import("./erasure").enqueueUserErasureFromClerk;
  let drainUserErasures: typeof import("./erasure").drainUserErasures;

  beforeAll(async () => {
    db = await createTestDb();
    ({ enqueueUserErasure, enqueueUserErasureFromClerk, drainUserErasures } = await import("./erasure"));
  }, 240_000);

  afterAll(async () => {
    await db?.teardown();
  });

  beforeEach(async () => {
    // Each case needs its own due job. In particular, the fencing case
    // intentionally leaves a queued job behind to prove stale writes fail.
    await db.pool.query("delete from account_erasure_jobs");
    await db.pool.query("delete from verifications");
    await db.pool.query("delete from runs");
    await db.pool.query("delete from users");
    await db.pool.query("delete from clerk_webhook_events");
    await db.pool.query("delete from account_erasure_tombstones");
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  async function eraseUser(userId: string): Promise<void> {
    await enqueueUserErasure(userId, db.pool);
    for (let pass = 0; pass < 10; pass++) {
      const result = await drainUserErasures(
        { maxJobs: 2 },
        { db: db.pool, deleteObject: vi.mocked(deleteObject) },
      );
      if (result.claimed === 0 || result.completed > 0) return;
    }
    throw new Error("erasure did not complete within the bounded test drain");
  }

  it("deletes R2 objects, run rows, and the user row; cascades comparisons/verifications", async () => {
    const userId = "user_erase_1";
    await ensureUser(userId, db.pool);
    await db.pool.query(
      "insert into verifications (user_id, hardware_vetted) values ($1, true)",
      [userId],
    );

    // A finalized run (with both a staging and final object) and a still-
    // pending one (whose deterministic staging key is not stored in Postgres).
    await insertRun(pendingRun("run_erase_finalized", userId), db.pool);
    await finalizeRun(
      {
        id: "run_erase_finalized",
        framesObjectKey: "runs/run_erase_finalized.parquet",
        stagingCleanup: { objectKey: "staging/runs/run_erase_finalized.parquet", notBefore: new Date() },
        visibility: RUN_VISIBILITY.unlisted,
        managementTokenHash: null,
        signature: null,
        gameId: null,
        gpuHardwareId: null,
        cpuHardwareId: null,
      },
      db.pool,
    );
    await insertRun(pendingRun("run_erase_pending", userId), db.pool);

    await eraseUser(userId);

    expect(deleteObject).toHaveBeenCalledTimes(3);
    expect(deleteObject).toHaveBeenCalledWith("staging/runs/run_erase_finalized.parquet");
    expect(deleteObject).toHaveBeenCalledWith("runs/run_erase_finalized.parquet");
    expect(deleteObject).toHaveBeenCalledWith("staging/runs/run_erase_pending.parquet");

    expect(await readRun("run_erase_finalized", db.pool)).toBeNull();
    expect(await readRun("run_erase_pending", db.pool)).toBeNull();

    const userRow = await db.pool.query("select 1 from users where id = $1", [userId]);
    expect(userRow.rows).toHaveLength(0);
    const verificationRow = await db.pool.query(
      "select 1 from verifications where user_id = $1",
      [userId],
    );
    expect(verificationRow.rows).toHaveLength(0);
  });

  it("is a no-op for a user with no runs", async () => {
    const userId = "user_erase_2";
    await ensureUser(userId, db.pool);

    await eraseUser(userId);

    expect(deleteObject).not.toHaveBeenCalled();
    const userRow = await db.pool.query("select 1 from users where id = $1", [userId]);
    expect(userRow.rows).toHaveLength(0);
  });

  it("rejects an ownerless private run at the database boundary", async () => {
    await expect(
      insertRun(
        {
          ...pendingRun("run_private_without_owner", "unused-owner"),
          ownerId: undefined,
          visibility: RUN_VISIBILITY.private,
        },
        db.pool,
      ),
    ).rejects.toMatchObject({ code: "23514", constraint: "runs_private_owner_check" });
  });

  it("fences stale owner writes before the asynchronous worker completes", async () => {
    const userId = "user_erase_fenced";
    await ensureUser(userId, db.pool);
    await enqueueUserErasure(userId, db.pool);

    await expect(ensureUser(userId, db.pool)).rejects.toBeInstanceOf(AccountErasedError);
    await expect(insertRun(pendingRun("run_erase_fenced", userId), db.pool)).rejects.toBeInstanceOf(
      RunOwnerUnavailableError,
    );
    expect((await db.pool.query("select erasure_requested_at from users where id = $1", [userId])).rows[0])
      .toEqual({ erasure_requested_at: expect.any(Date) });
  });

  it("deduplicates a replayed Clerk deletion event without exposing a second lease", async () => {
    const userId = "user_erase_webhook_dedupe";
    await ensureUser(userId, db.pool);
    await enqueueUserErasureFromClerk(userId, "msg_erase_once", db.pool);
    await enqueueUserErasureFromClerk(userId, "msg_erase_once", db.pool);

    expect(
      (await db.pool.query("select count(*) from account_erasure_jobs where user_id = $1", [userId])).rows[0],
    ).toEqual({ count: "1" });
    expect(
      (await db.pool.query("select count(*) from clerk_webhook_events where svix_id = $1", ["msg_erase_once"])).rows[0],
    ).toEqual({ count: "1" });
  });

  it("erases a large account in bounded durable batches", async () => {
    const userId = "user_erase_batched";
    await ensureUser(userId, db.pool);
    for (let index = 0; index < 21; index++) {
      await insertRun(pendingRun(`run_erase_batch_${index}`, userId), db.pool);
    }

    await enqueueUserErasure(userId, db.pool);
    const first = await drainUserErasures({ maxJobs: 1 }, { db: db.pool, deleteObject: vi.mocked(deleteObject) });
    expect(first).toMatchObject({ claimed: 1, completed: 0, deletedRuns: 20 });
    expect(
      (await db.pool.query("select count(*) from runs where user_id = $1", [userId])).rows[0],
    ).toEqual({ count: "1" });

    const second = await drainUserErasures({ maxJobs: 1 }, { db: db.pool, deleteObject: vi.mocked(deleteObject) });
    expect(second).toMatchObject({ claimed: 1, completed: 1, deletedRuns: 1 });
    expect((await db.pool.query("select 1 from users where id = $1", [userId])).rows).toHaveLength(0);
  });

  it("keeps the tombstone and job when an R2 deletion fails", async () => {
    const userId = "user_erase_retry";
    await ensureUser(userId, db.pool);
    await insertRun(pendingRun("run_erase_retry", userId), db.pool);
    await finalizeRun(
      {
        id: "run_erase_retry",
        framesObjectKey: "runs/run_erase_retry.parquet",
        stagingCleanup: { objectKey: "staging/runs/run_erase_retry.parquet", notBefore: new Date() },
        visibility: RUN_VISIBILITY.unlisted,
        managementTokenHash: null,
        signature: null,
        gameId: null,
        gpuHardwareId: null,
        cpuHardwareId: null,
      },
      db.pool,
    );
    vi.mocked(deleteObject).mockRejectedValueOnce(new Error("R2 unavailable"));

    await enqueueUserErasure(userId, db.pool);
    const result = await drainUserErasures({ maxJobs: 1 }, { db: db.pool, deleteObject: vi.mocked(deleteObject) });

    expect(result).toMatchObject({ claimed: 1, completed: 0, retried: 1, deletedRuns: 0 });
    expect((await readRun("run_erase_retry", db.pool))?.status).toBe(RUN_STATUS.hidden);
    expect((await db.pool.query("select 1 from account_erasure_jobs where user_id = $1", [userId])).rows).toHaveLength(1);
    expect((await db.pool.query("select 1 from users where id = $1", [userId])).rows).toHaveLength(1);
  });

  it("is idempotent when retried after the user row is already gone", async () => {
    const userId = "user_erase_3";
    await ensureUser(userId, db.pool);

    await eraseUser(userId);
    await expect(eraseUser(userId)).resolves.toBeUndefined();
  });

  it("erases an admin who granted verifications to other users", async () => {
    // `verifications.verified_by` pointed at `users(id)` with no ON DELETE
    // action, so an admin who had ever granted the verified tier could never
    // be erased: the delete raised a FK violation, the webhook 500'd, and
    // Svix retried the same event forever. The Phase 8 schema migration makes
    // the grant's author reference `set null` when that admin is erased.
    const admin = "user_erase_admin";
    const subject = "user_erase_subject";
    await ensureUser(admin, db.pool);
    await ensureUser(subject, db.pool);
    await db.pool.query(
      "insert into verifications (user_id, verified_by, hardware_vetted) values ($1, $2, true)",
      [subject, admin],
    );

    await expect(eraseUser(admin)).resolves.toBeUndefined();

    const adminRow = await db.pool.query("select 1 from users where id = $1", [admin]);
    expect(adminRow.rows).toHaveLength(0);
    // The grant itself survives the granter, with the reference nulled out.
    const grant = await db.pool.query(
      "select verified_by from verifications where user_id = $1",
      [subject],
    );
    expect(grant.rows).toEqual([{ verified_by: null }]);
  });

  it("does not allow a later stale session to rebuild an erased row", async () => {
    const userId = "user_erase_4";
    await ensureUser(userId, db.pool);
    await eraseUser(userId);

    await expect(ensureUser(userId, db.pool)).rejects.toBeInstanceOf(AccountErasedError);
  });
});
