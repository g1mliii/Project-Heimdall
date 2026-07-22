/**
 * Admin moderation route integration coverage (§20.5): GET/PATCH
 * /api/admin/reports[/:id], POST /api/admin/runs/:id/moderate, and PATCH
 * /api/admin/games/:id. Real Postgres; the auth seam is mocked, never Clerk.
 */

import { NextResponse } from "next/server";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { RUN_STATUS, RUN_VISIBILITY, validRun } from "@heimdall/shared";
import type { Run } from "@heimdall/shared";
import { insertRun } from "@/lib/db";
import { createTestDb, testDbAvailable, type TestDb } from "@/lib/testing/test-db";
import { resolveGameId } from "@/lib/repo/catalog";
import { createReport } from "@/lib/repo/reports";

const { getViewer, requireAdmin } = vi.hoisted(() => ({
  getViewer: { current: async (): Promise<unknown> => null },
  requireAdmin: { current: async (): Promise<unknown> => null },
}));
vi.mock("@/lib/api/auth", () => ({
  getViewer: vi.fn(() => getViewer.current()),
  requireAdmin: vi.fn(() => requireAdmin.current()),
}));

import { GET as listReports } from "./route";
import { PATCH as patchReport } from "./[id]/route";
import { POST as moderateRun } from "../runs/[id]/moderate/route";
import { PATCH as renameGame } from "../games/[id]/route";

const ADMIN = { userId: "user_mod_admin", role: "admin" as const };
const NON_ADMIN = { userId: "user_mod_nonadmin", role: "public" as const };

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

function jsonRequest(url: string, body: unknown, method = "PATCH") {
  return new Request(url, {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function ctx(id: string) {
  return { params: Promise.resolve({ id }) };
}

function makeRun(id: string): Run {
  return {
    ...validRun,
    id,
    status: RUN_STATUS.pending,
    visibility: RUN_VISIBILITY.unlisted,
    framesObjectKey: undefined,
    signatureValid: undefined,
  };
}

const canRun = testDbAvailable("admin-moderation-api.test");

describe.skipIf(!canRun)("admin moderation routes (§20.5)", () => {
  let db: TestDb;

  beforeAll(async () => {
    db = await createTestDb();
    process.env.DATABASE_URL = db.connectionString;
    await db.pool.query(
      `insert into users (id, role) values ($1, 'admin'), ($2, 'public')
       on conflict (id) do nothing`,
      [ADMIN.userId, NON_ADMIN.userId],
    );
  }, 240_000);

  afterAll(async () => {
    const globalPool = (globalThis as { __heimdallPgPool?: { end(): Promise<void> } })
      .__heimdallPgPool;
    await globalPool?.end();
    await db?.teardown();
  });

  beforeEach(() => {
    setViewer(null);
  });

  it("GET reports: 401s anonymous, 403s non-admin, lists open reports for an admin", async () => {
    await insertRun(makeRun("run_mod_list"), db.pool);
    const report = await createReport(
      { subjectType: "run", subjectRunId: "run_mod_list", reason: "abusive-name", reporterUserId: null },
      db.pool,
    );

    const anon = await listReports();
    expect(anon.status).toBe(401);

    setViewer(NON_ADMIN);
    const forbidden = await listReports();
    expect(forbidden.status).toBe(403);

    setViewer(ADMIN);
    const response = await listReports();
    expect(response.status).toBe(200);
    const body = (await response.json()) as { reports: Array<{ id: string }>; nextCursor: string | null };
    expect(body.reports.some((r) => r.id === report.id)).toBe(true);
  });

  it("PATCH report: dismiss transitions status; 404s a second time", async () => {
    await insertRun(makeRun("run_mod_dismiss"), db.pool);
    const report = await createReport(
      { subjectType: "run", subjectRunId: "run_mod_dismiss", reason: "other", reporterUserId: null },
      db.pool,
    );

    setViewer(ADMIN);
    const first = await patchReport(
      jsonRequest(`http://test/api/admin/reports/${report.id}`, { status: "dismissed" }),
      ctx(report.id),
    );
    expect(first.status).toBe(204);

    const second = await patchReport(
      jsonRequest(`http://test/api/admin/reports/${report.id}`, { status: "dismissed" }),
      ctx(report.id),
    );
    expect(second.status).toBe(404);
  });

  it("POST moderate run: 401s anonymous, 403s non-admin; an admin hides the run and resolves its reports", async () => {
    await insertRun(makeRun("run_mod_hide"), db.pool);
    const report = await createReport(
      { subjectType: "run", subjectRunId: "run_mod_hide", reason: "bad-faith-upload", reporterUserId: null },
      db.pool,
    );

    const anon = await moderateRun(new Request("http://test", { method: "POST" }), ctx("run_mod_hide"));
    expect(anon.status).toBe(401);

    setViewer(NON_ADMIN);
    const forbidden = await moderateRun(
      new Request("http://test", { method: "POST" }),
      ctx("run_mod_hide"),
    );
    expect(forbidden.status).toBe(403);

    setViewer(ADMIN);
    const response = await moderateRun(
      new Request("http://test", { method: "POST" }),
      ctx("run_mod_hide"),
    );
    expect(response.status).toBe(204);

    const runRow = await db.pool.query("select status from runs where id = $1", ["run_mod_hide"]);
    expect(runRow.rows[0]).toEqual({ status: "moderated" });

    const stillOpen = await listReports();
    const stillOpenBody = (await stillOpen.json()) as {
      reports: Array<{ id: string }>;
      nextCursor: string | null;
    };
    expect(stillOpenBody.reports.some((r) => r.id === report.id)).toBe(false);
  });

  it("PATCH game: 401s anonymous, 403s non-admin; an admin renames it", async () => {
    const gameId = await resolveGameId("capframex", "Typo'd Game Naem", db.pool);
    if (!gameId) throw new Error("expected a resolvable game id");

    const anon = await renameGame(
      jsonRequest(`http://test/api/admin/games/${gameId}`, { name: "Fixed Game Name" }),
      ctx(gameId),
    );
    expect(anon.status).toBe(401);

    setViewer(NON_ADMIN);
    const forbidden = await renameGame(
      jsonRequest(`http://test/api/admin/games/${gameId}`, { name: "Fixed Game Name" }),
      ctx(gameId),
    );
    expect(forbidden.status).toBe(403);

    setViewer(ADMIN);
    const response = await renameGame(
      jsonRequest(`http://test/api/admin/games/${gameId}`, { name: "Fixed Game Name" }),
      ctx(gameId),
    );
    expect(response.status).toBe(200);

    const row = await db.pool.query("select name from games where id = $1::bigint", [gameId]);
    expect(row.rows[0]).toEqual({ name: "Fixed Game Name" });
  });

  it("PATCH game: 404s a non-numeric or unknown id", async () => {
    setViewer(ADMIN);
    const nonNumeric = await renameGame(
      jsonRequest("http://test/api/admin/games/not-a-number", { name: "X" }),
      ctx("not-a-number"),
    );
    expect(nonNumeric.status).toBe(404);

    const unknown = await renameGame(
      jsonRequest("http://test/api/admin/games/999999999", { name: "X" }),
      ctx("999999999"),
    );
    expect(unknown.status).toBe(404);
  });
});
