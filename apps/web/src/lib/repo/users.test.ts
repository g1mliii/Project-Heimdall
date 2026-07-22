/**
 * User provisioning coverage (§20.1b). Real Postgres via the shared harness
 * (see testing/test-db.ts) — the promote-only admin bootstrap and the
 * JIT-vs-webhook write-path split are the load-bearing behaviors here.
 */

import { beforeAll, afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb, testDbAvailable, type TestDb } from "../testing/test-db";
import { accountErasureFenceKey } from "../erasure-fence";
import {
  AccountErasedError,
  ensureUser,
  isValidHandle,
  pruneClerkWebhookEvents,
  syncUserFromClerk,
  syncUserFromClerkEvent,
  updateUserHandle,
} from "./users";

const canRun = testDbAvailable("users.test");
const BOOTSTRAP_ADMIN_ID = "user_bootstrap_admin";

vi.stubEnv(
  "CLERK_ADMIN_USER_IDS",
  ` ${BOOTSTRAP_ADMIN_ID} , user_other_admin , user_preexisting_admin `,
);

describe.skipIf(!canRun)("user provisioning (§20.1b)", () => {
  let db: TestDb;

  beforeAll(async () => {
    db = await createTestDb();
  }, 240_000);

  afterAll(async () => {
    await db?.teardown();
  });

  beforeEach(async () => {
    await db.pool.query("delete from clerk_webhook_events");
    await db.pool.query("delete from account_erasure_tombstones");
    await db.pool.query("delete from users");
  });

  describe("ensureUser (JIT upsert)", () => {
    it("creates a public-role row with no handle/email on first sign-in", async () => {
      const user = await ensureUser("user_jit_1", db.pool);
      expect(user).toEqual({ id: "user_jit_1", handle: null, email: null, role: "public" });
    });

    it("is idempotent and never touches handle/email set elsewhere", async () => {
      await syncUserFromClerk("user_jit_2", { handle: "ada", email: "ada@example.com" }, db.pool);
      const user = await ensureUser("user_jit_2", db.pool);
      expect(user).toEqual({
        id: "user_jit_2",
        handle: "ada",
        email: "ada@example.com",
        role: "public",
      });
    });

    it("promotes a bootstrap admin id on JIT upsert (promote-only)", async () => {
      const user = await ensureUser(BOOTSTRAP_ADMIN_ID, db.pool);
      expect(user.role).toBe("admin");
    });

    it("promotes an id already stored with a lesser role (promote-only)", async () => {
      // Simulates the bootstrap list growing to include an existing user —
      // `ensureUser` must promote on its very first call for this id, not
      // just at row creation. Seeded directly (not via `ensureUser`) so the
      // the direct seed does not exercise a prior provisioning path.
      await db.pool.query("insert into users (id, role) values ($1, 'public')", [
        "user_preexisting_admin",
      ]);
      const user = await ensureUser("user_preexisting_admin", db.pool);
      expect(user.role).toBe("admin");
    });

    it("never demotes a pre-existing elevated role for a non-bootstrap user", async () => {
      await db.pool.query("insert into users (id, role) values ($1, 'verified')", [
        "user_verified",
      ]);
      const user = await ensureUser("user_verified", db.pool);
      expect(user.role).toBe("verified");
    });

    it("rejects a stale session after the durable erasure fence is written", async () => {
      // §20.4: the memo says "already provisioned" but the row is gone. Before
      // the self-heal, `ensureUser` skipped the upsert and threw on the empty
      // select — a 500 out of `getViewer()` for anyone whose session outlived
      // their account deletion.
      const userId = "user_memo_stale";
      await ensureUser(userId, db.pool);
      await db.pool.query("delete from users where id = $1", [userId]);
      await db.pool.query("insert into account_erasure_tombstones (user_id_hash) values ($1)", [
        accountErasureFenceKey(userId),
      ]);

      await expect(ensureUser(userId, db.pool)).rejects.toBeInstanceOf(AccountErasedError);
    });
  });

  describe("syncUserFromClerk (webhook upsert)", () => {
    it("sets handle and email from the Clerk payload", async () => {
      const user = await syncUserFromClerk(
        "user_wh_1",
        { handle: "grace", email: "grace@example.com" },
        db.pool,
      );
      expect(user).toEqual({
        id: "user_wh_1",
        handle: "grace",
        email: "grace@example.com",
        role: "public",
      });
    });

    it("overwrites email on a later sync but preserves an elevated role", async () => {
      await syncUserFromClerk("user_wh_2", { handle: "old", email: "old@example.com" }, db.pool);
      await db.pool.query("update users set role = 'verified' where id = $1", ["user_wh_2"]);
      const user = await syncUserFromClerk(
        "user_wh_2",
        { handle: "new", email: "new@example.com" },
        db.pool,
      );
      expect(user).toEqual({
        id: "user_wh_2",
        // Email is Clerk-managed and follows the payload; `handle` is ours and
        // only ever gets FILLED by Clerk — see the next two tests.
        handle: "old",
        email: "new@example.com",
        role: "verified",
      });
    });

    it("never nulls an existing handle when Clerk sends no username", async () => {
      // Clerk instances with the username field disabled send `username: null`
      // on every event. Before the coalesce, an unrelated profile edit wiped
      // the handle and reverted every submission's attribution to "Anonymous".
      await syncUserFromClerk("user_wh_3", { handle: "grace", email: "g@example.com" }, db.pool);
      const user = await syncUserFromClerk(
        "user_wh_3",
        { handle: null, email: "g2@example.com" },
        db.pool,
      );
      expect(user.handle).toBe("grace");
      expect(user.email).toBe("g2@example.com");
    });

    it("never overwrites a handle the user chose via PATCH /api/account", async () => {
      await syncUserFromClerk("user_wh_4", { handle: null, email: "h@example.com" }, db.pool);
      await updateUserHandle("user_wh_4", "framecat", db.pool);
      const user = await syncUserFromClerk(
        "user_wh_4",
        { handle: "clerk-renamed", email: "h@example.com" },
        db.pool,
      );
      expect(user.handle).toBe("framecat");
    });

    it("syncs without a handle when the Clerk username collides with an existing one", async () => {
      // `users.handle` is unique but Clerk usernames are not drawn from our
      // namespace. An uncaught unique violation 500s the webhook and Svix
      // then retries forever, never provisioning the user at all.
      await syncUserFromClerk("user_wh_5a", { handle: "taken", email: "a@example.com" }, db.pool);
      const user = await syncUserFromClerk(
        "user_wh_5b",
        { handle: "taken", email: "b@example.com" },
        db.pool,
      );
      expect(user).toEqual({
        id: "user_wh_5b",
        handle: null,
        email: "b@example.com",
        role: "public",
      });
    });

    it("promotes a bootstrap admin id even via the webhook path", async () => {
      const user = await syncUserFromClerk(
        "user_other_admin",
        { handle: null, email: null },
        db.pool,
      );
      expect(user.role).toBe("admin");
    });

    it("deduplicates a Svix profile event without applying a second update", async () => {
      const event = {
        svixId: "msg_profile_dedupe",
        type: "user.updated" as const,
        userId: "user_webhook_dedupe",
        profile: { handle: "first", email: "first@example.com" },
      };
      expect(await syncUserFromClerkEvent(event, db.pool)).toMatchObject({ email: "first@example.com" });
      expect(
        await syncUserFromClerkEvent(
          { ...event, profile: { handle: "second", email: "second@example.com" } },
          db.pool,
        ),
      ).toBeNull();
      expect(await ensureUser(event.userId, db.pool)).toMatchObject({ email: "first@example.com" });
    });

    it("does not recreate an account when an older profile event follows deletion", async () => {
      const userId = "user_webhook_deleted";
      await db.pool.query("insert into account_erasure_tombstones (user_id_hash) values ($1)", [
        accountErasureFenceKey(userId),
      ]);

      await expect(
        syncUserFromClerkEvent(
          {
            svixId: "msg_profile_after_delete",
            type: "user.updated",
            userId,
            profile: { handle: "should-not-exist", email: "should-not-exist@example.com" },
          },
          db.pool,
        ),
      ).resolves.toBeNull();
      expect((await db.pool.query("select 1 from users where id = $1", [userId])).rows).toHaveLength(0);
    });

    it("prunes old Svix delivery dedupe rows in bounded batches", async () => {
      await db.pool.query(
        `insert into clerk_webhook_events (svix_id, user_id_hash, event_type, received_at)
         values ($1, $2, 'user.updated', now() - interval '31 days'),
                ($3, $4, 'user.updated', now())`,
        [
          "msg_old_delivery",
          accountErasureFenceKey("user_old_delivery"),
          "msg_fresh_delivery",
          accountErasureFenceKey("user_fresh_delivery"),
        ],
      );
      expect(await pruneClerkWebhookEvents({ limit: 1 }, db.pool)).toBe(1);
      expect(
        (await db.pool.query("select svix_id from clerk_webhook_events order by svix_id")).rows,
      ).toEqual([{ svix_id: "msg_fresh_delivery" }]);
    });
  });

  describe("isValidHandle", () => {
    it.each(["ada", "ada-lovelace", "a12345"])("accepts %s", (handle) => {
      expect(isValidHandle(handle)).toBe(true);
    });

    it.each([
      "ab", // too short
      "-ada", // must start alphanumeric
      "Ada", // no uppercase
      "ada_lovelace", // no underscore
      "admin", // reserved
      "runs", // reserved
    ])("rejects %s", (handle) => {
      expect(isValidHandle(handle)).toBe(false);
    });
  });

  describe("updateUserHandle", () => {
    it("updates the handle for an existing user", async () => {
      await ensureUser("user_edit_1", db.pool);
      const updated = await updateUserHandle("user_edit_1", "newhandle", db.pool);
      expect(updated?.handle).toBe("newhandle");
    });

    it("returns null for a nonexistent user", async () => {
      expect(await updateUserHandle("user_missing", "somehandle", db.pool)).toBeNull();
    });
  });
});
