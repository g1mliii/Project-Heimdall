/**
 * POST/DELETE /api/admin/verifications integration coverage (§20.3):
 * admin-only; grant/revoke atomically write `verifications` + `users.role`;
 * both are no-ops against an existing admin's role.
 */

import { NextResponse } from "next/server";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb, testDbAvailable, type TestDb } from "@/lib/testing/test-db";

const { getViewer, requireAdmin } = vi.hoisted(() => ({
  getViewer: { current: async (): Promise<unknown> => null },
  requireAdmin: { current: async (): Promise<unknown> => null },
}));
vi.mock("@/lib/api/auth", () => ({
  getViewer: vi.fn(() => getViewer.current()),
  requireAdmin: vi.fn(() => requireAdmin.current()),
}));

import { POST as grant, DELETE as revoke } from "./route";

const ADMIN = { userId: "user_verif_admin", role: "admin" as const };
const NON_ADMIN = { userId: "user_verif_nonadmin", role: "public" as const };
const TARGET = "user_verif_target";

const UNAUTHORIZED = () =>
  NextResponse.json({ error: { code: "auth-required", message: "sign in required" } }, { status: 401 });
const FORBIDDEN = () =>
  NextResponse.json({ error: { code: "forbidden", message: "admin role required" } }, { status: 403 });

function setViewer(viewer: typeof ADMIN | typeof NON_ADMIN | null) {
  getViewer.current = async () => viewer;
  requireAdmin.current = async () => {
    if (!viewer) return UNAUTHORIZED();
    if (viewer.role !== "admin") return FORBIDDEN();
    return viewer;
  };
}

function jsonRequest(body: unknown, method = "POST") {
  return new Request("http://test/api/admin/verifications", {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

const canRun = testDbAvailable("admin-verifications-api.test");

describe.skipIf(!canRun)("admin verifications API (§20.3)", () => {
  let db: TestDb;

  beforeAll(async () => {
    db = await createTestDb();
    process.env.DATABASE_URL = db.connectionString;
    await db.pool.query(
      `insert into users (id, role) values ($1, 'admin'), ($2, 'public'), ($3, 'public')
       on conflict (id) do nothing`,
      [ADMIN.userId, NON_ADMIN.userId, TARGET],
    );
  }, 240_000);

  afterAll(async () => {
    const globalPool = (globalThis as { __heimdallPgPool?: { end(): Promise<void> } })
      .__heimdallPgPool;
    await globalPool?.end();
    await db?.teardown();
  });

  beforeEach(async () => {
    setViewer(null);
    await db.pool.query("delete from verifications where user_id = $1", [TARGET]);
    await db.pool.query("update users set role = 'public' where id = $1", [TARGET]);
  });

  it("POST: 401s anonymous, 403s a non-admin, grants for an admin", async () => {
    const anon = await grant(jsonRequest({ userId: TARGET }));
    expect(anon.status).toBe(401);

    setViewer(NON_ADMIN);
    const forbidden = await grant(jsonRequest({ userId: TARGET }));
    expect(forbidden.status).toBe(403);

    setViewer(ADMIN);
    const response = await grant(jsonRequest({ userId: TARGET, hardwareVetted: true }));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ id: TARGET, role: "verified" });

    const verificationRow = await db.pool.query(
      "select verified_by, hardware_vetted from verifications where user_id = $1",
      [TARGET],
    );
    expect(verificationRow.rows[0]).toEqual({
      verified_by: ADMIN.userId,
      hardware_vetted: true,
    });
  });

  it("DELETE: 401s anonymous, 403s a non-admin, revokes for an admin", async () => {
    setViewer(ADMIN);
    await grant(jsonRequest({ userId: TARGET, hardwareVetted: false }));

    setViewer(null);
    const anon = await revoke(jsonRequest({ userId: TARGET }, "DELETE"));
    expect(anon.status).toBe(401);

    setViewer(NON_ADMIN);
    const forbidden = await revoke(jsonRequest({ userId: TARGET }, "DELETE"));
    expect(forbidden.status).toBe(403);

    setViewer(ADMIN);
    const response = await revoke(jsonRequest({ userId: TARGET }, "DELETE"));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ id: TARGET, role: "public" });
    expect(
      (await db.pool.query("select 1 from verifications where user_id = $1", [TARGET])).rows,
    ).toHaveLength(0);
  });

  it("grant/revoke are no-ops against an existing admin's role", async () => {
    const otherAdmin = "user_verif_other_admin";
    await db.pool.query(
      "insert into users (id, role) values ($1, 'admin') on conflict (id) do update set role = 'admin'",
      [otherAdmin],
    );
    setViewer(ADMIN);

    const granted = await grant(jsonRequest({ userId: otherAdmin }));
    expect((await granted.json()).role).toBe("admin");

    const revoked = await revoke(jsonRequest({ userId: otherAdmin }, "DELETE"));
    expect((await revoked.json()).role).toBe("admin");
  });

  it("does not create an audit record when the target user does not exist", async () => {
    const missing = "user_verif_missing";
    setViewer(ADMIN);

    const response = await grant(jsonRequest({ userId: missing, hardwareVetted: true }));

    expect(response.status).toBe(404);
    expect((await db.pool.query("select 1 from verifications where user_id = $1", [missing])).rows).toHaveLength(
      0,
    );
  });
});
