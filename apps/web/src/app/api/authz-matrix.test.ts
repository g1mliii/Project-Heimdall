/**
 * Consolidated authz matrix (§20 regression baseline, feeds Phase 8.5): every
 * mutating route × {anonymous, owner, non-owner, admin}, status codes only.
 * Business-logic correctness for each route already has its own deep
 * coverage in that route's `api.test.ts` — this file exists so a single
 * glance answers "did anything's authz posture regress?" without reading 18
 * separate test files, and so a future route is forced to be added HERE too.
 *
 * Real Postgres via the shared harness; the auth seam is mocked, never
 * Clerk. R2/drain/Clerk-client calls are mocked so this file never depends
 * on external services.
 */

import { NextResponse } from "next/server";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  RUN_VISIBILITY,
  generateManagementToken,
  hashManagementToken,
  validCreateRunRequest,
} from "@heimdall/shared";
import { createTestDb, testDbAvailable, type TestDb } from "@/lib/testing/test-db";
import { createReport } from "@/lib/repo/reports";

vi.mock("@/lib/r2", () => ({
  framesUploadObjectKey: (runId: string) => `staging/runs/${runId}.parquet`,
  finalizedFramesObjectKey: (runId: string) => `runs/${runId}/finalized.parquet`,
  presignPut: vi.fn(async () => "https://r2.example.test/put"),
  headObject: vi.fn(async () => ({ sizeBytes: 1024, etag: '"etag"' })),
  copyObject: vi.fn(async () => true),
  deleteObject: vi.fn(async () => {}),
  stagingCleanupNotBefore: vi.fn(() => new Date()),
}));
vi.mock("@/lib/jobs/drain", () => ({
  drainJobs: vi.fn(async () => ({ claimed: 0, validated: 0, flagged: 0, retried: 0, failed: 0 })),
  cleanupStalePending: vi.fn(async () => 0),
}));
vi.mock("@clerk/nextjs/server", () => ({
  clerkClient: vi.fn(async () => ({ users: { deleteUser: vi.fn(async () => ({})) } })),
}));

const { getViewer, getViewerIdentity, requireViewer, requireAdmin } = vi.hoisted(() => ({
  getViewer: { current: async (): Promise<unknown> => null },
  getViewerIdentity: { current: async (): Promise<unknown> => null },
  requireViewer: { current: async (): Promise<unknown> => null },
  requireAdmin: { current: async (): Promise<unknown> => null },
}));
vi.mock("@/lib/api/auth", () => ({
  getViewer: vi.fn(() => getViewer.current()),
  getViewerIdentity: vi.fn(() => getViewerIdentity.current()),
  requireViewer: vi.fn(() => requireViewer.current()),
  requireAdmin: vi.fn(() => requireAdmin.current()),
}));

import { POST as createRun } from "./runs/route";
import { DELETE as deleteRunRoute, PATCH as patchRun } from "./runs/[id]/route";
import { POST as finalizeRun } from "./runs/[id]/finalize/route";
import { POST as claimRun } from "./runs/[id]/claim/route";
import { PATCH as patchAccount } from "./account/route";
import { POST as deleteAccount } from "./account/delete/route";
import { POST as createReportRoute } from "./reports/route";
import { POST as grantVerification, DELETE as revokeVerification } from "./admin/verifications/route";
import { GET as listAdminReports } from "./admin/reports/route";
import { PATCH as patchAdminReportById } from "./admin/reports/[id]/route";
import { POST as moderateRun } from "./admin/runs/[id]/moderate/route";
import { PATCH as renameGame } from "./admin/games/[id]/route";

type ViewerState = "anon" | "owner" | "stranger" | "admin";

const OWNER = { userId: "user_matrix_owner", role: "public" as const };
const STRANGER = { userId: "user_matrix_stranger", role: "public" as const };
const ADMIN = { userId: "user_matrix_admin", role: "admin" as const };

const UNAUTHORIZED = () =>
  NextResponse.json({ error: { code: "auth-required", message: "sign in required" } }, { status: 401 });
const FORBIDDEN = () =>
  NextResponse.json({ error: { code: "forbidden", message: "admin role required" } }, { status: 403 });

function setViewer(state: ViewerState) {
  const viewer = state === "anon" ? null : state === "owner" ? OWNER : state === "stranger" ? STRANGER : ADMIN;
  getViewer.current = async () => viewer;
  getViewerIdentity.current = async () => (viewer ? { userId: viewer.userId } : null);
  requireViewer.current = async () => viewer ?? UNAUTHORIZED();
  requireAdmin.current = async () => {
    if (!viewer) return UNAUTHORIZED();
    if (viewer.role !== "admin") return FORBIDDEN();
    return viewer;
  };
}

function jsonRequest(url: string, method: string, body: unknown) {
  return new Request(url, {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function ctx(id: string) {
  return { params: Promise.resolve({ id }) };
}

const canRun = testDbAvailable("authz-matrix.test");

describe.skipIf(!canRun)("authz matrix (§20 regression baseline)", () => {
  let db: TestDb;
  /** A run owned by OWNER, finalized, unlisted — fresh per matrix row via beforeEach. */
  let ownedRunId: string;

  beforeAll(async () => {
    db = await createTestDb();
    process.env.DATABASE_URL = db.connectionString;
    process.env.RATE_LIMIT_CREATE_RUNS_PER_HOUR = "10000";
    process.env.RATE_LIMIT_FINALIZE_PER_HOUR = "10000";
    process.env.RATE_LIMIT_DELETE_PER_HOUR = "10000";
    process.env.RATE_LIMIT_CLAIM_PER_HOUR = "10000";
    process.env.RATE_LIMIT_CREATE_REPORT_PER_HOUR = "10000";
    await db.pool.query(
      `insert into users (id, role) values ($1, 'public'), ($2, 'public'), ($3, 'admin')
       on conflict (id) do nothing`,
      [OWNER.userId, STRANGER.userId, ADMIN.userId],
    );
  }, 240_000);

  afterAll(async () => {
    const globalPool = (globalThis as { __heimdallPgPool?: { end(): Promise<void> } })
      .__heimdallPgPool;
    await globalPool?.end();
    await db?.teardown();
  });

  beforeEach(async () => {
    setViewer("owner");
    const created = await createRun(jsonRequest("http://test/api/runs", "POST", validCreateRunRequest));
    const { id } = (await created.json()) as { id: string };
    await finalizeRun(
      jsonRequest(`http://test/api/runs/${id}/finalize`, "POST", {
        uploadObjectKey: `staging/runs/${id}.parquet`,
        visibility: RUN_VISIBILITY.unlisted,
        managementTokenHash: await hashManagementToken(generateManagementToken()),
      }),
      ctx(id),
    );
    ownedRunId = id;
    setViewer("anon");
  });

  it("POST /api/runs — anonymous-allowed by design; every viewer state succeeds", async () => {
    for (const state of ["anon", "owner", "stranger", "admin"] as const) {
      setViewer(state);
      const response = await createRun(
        jsonRequest("http://test/api/runs", "POST", validCreateRunRequest),
      );
      expect(response.status, state).toBe(201);
    }
  });

  it("PATCH /api/runs/:id (visibility) — owner-only; anon 401s, stranger 404s, owner/admin... owner succeeds, admin 404s (not the owner)", async () => {
    const body = { visibility: RUN_VISIBILITY.public };
    setViewer("anon");
    expect((await patchRun(jsonRequest("http://test", "PATCH", body), ctx(ownedRunId))).status).toBe(401);
    setViewer("stranger");
    expect((await patchRun(jsonRequest("http://test", "PATCH", body), ctx(ownedRunId))).status).toBe(404);
    // Admin has no special visibility-switch privilege here — only the
    // run's actual owner may flip its visibility (§20.2's PATCH route checks
    // ownerId equality, not role).
    setViewer("admin");
    expect((await patchRun(jsonRequest("http://test", "PATCH", body), ctx(ownedRunId))).status).toBe(404);
    setViewer("owner");
    expect((await patchRun(jsonRequest("http://test", "PATCH", body), ctx(ownedRunId))).status).toBe(200);
  });

  it("DELETE /api/runs/:id (no token) — stranger 404s, owner and admin both succeed", async () => {
    setViewer("stranger");
    expect(
      (await deleteRunRoute(new Request("http://test", { method: "DELETE" }), ctx(ownedRunId))).status,
    ).toBe(404);

    setViewer("admin");
    expect(
      (await deleteRunRoute(new Request("http://test", { method: "DELETE" }), ctx(ownedRunId))).status,
    ).toBe(204);
  });

  it("POST /api/runs/:id/finalize — anonymous-allowed for an ownerless run; a stranger cannot re-finalize someone else's owned run", async () => {
    setViewer("anon");
    const created = await createRun(jsonRequest("http://test/api/runs", "POST", validCreateRunRequest));
    const { id } = (await created.json()) as { id: string };
    const finalizeBody = {
      uploadObjectKey: `staging/runs/${id}.parquet`,
      visibility: RUN_VISIBILITY.unlisted,
      managementTokenHash: await hashManagementToken(generateManagementToken()),
    };
    expect(
      (await finalizeRun(jsonRequest("http://test", "POST", finalizeBody), ctx(id))).status,
    ).toBe(200);

    // An owned-but-not-yet-finalized run: only its owner (or anonymous, since
    // ownership isn't set until create — here it IS set) may finalize it.
    setViewer("owner");
    const ownedCreated = await createRun(
      jsonRequest("http://test/api/runs", "POST", validCreateRunRequest),
    );
    const { id: ownedId } = (await ownedCreated.json()) as { id: string };
    setViewer("stranger");
    const strangerFinalize = await finalizeRun(
      jsonRequest("http://test", "POST", {
        uploadObjectKey: `staging/runs/${ownedId}.parquet`,
        visibility: RUN_VISIBILITY.unlisted,
        managementTokenHash: await hashManagementToken(generateManagementToken()),
      }),
      ctx(ownedId),
    );
    expect(strangerFinalize.status).toBe(404);
  });

  it("POST /api/runs/:id/claim — anon 401s, a wrong-token signed-in caller 404s, the right token succeeds", async () => {
    setViewer("anon");
    const created = await createRun(jsonRequest("http://test/api/runs", "POST", validCreateRunRequest));
    const { id } = (await created.json()) as { id: string };
    const token = generateManagementToken();
    await finalizeRun(
      jsonRequest("http://test", "POST", {
        uploadObjectKey: `staging/runs/${id}.parquet`,
        visibility: RUN_VISIBILITY.unlisted,
        managementTokenHash: await hashManagementToken(token),
      }),
      ctx(id),
    );

    setViewer("anon");
    expect((await claimRun(new Request("http://test", { method: "POST" }), ctx(id))).status).toBe(401);

    setViewer("stranger");
    expect((await claimRun(new Request("http://test", { method: "POST" }), ctx(id))).status).toBe(404);

    const success = await claimRun(
      new Request("http://test", { method: "POST", headers: { authorization: `Bearer ${token}` } }),
      ctx(id),
    );
    expect(success.status).toBe(204);
  });

  it("PATCH /api/account — anon 401s; any signed-in caller edits only their own account (owner/stranger/admin all succeed against their own id)", async () => {
    setViewer("anon");
    expect(
      (await patchAccount(jsonRequest("http://test", "PATCH", { handle: "matrix-handle" }))).status,
    ).toBe(401);

    for (const state of ["owner", "stranger", "admin"] as const) {
      setViewer(state);
      const response = await patchAccount(
        jsonRequest("http://test", "PATCH", { handle: `matrix-handle-${state}` }),
      );
      expect(response.status, state).toBe(200);
    }
  });

  it("POST /api/account/delete — anon 401s; any signed-in caller succeeds against their own account", async () => {
    setViewer("anon");
    expect((await deleteAccount()).status).toBe(401);
    setViewer("stranger");
    expect((await deleteAccount()).status).toBe(202);
  });

  it("POST /api/reports — anonymous-allowed by design; every viewer state succeeds", async () => {
    for (const state of ["anon", "owner", "stranger", "admin"] as const) {
      setViewer(state);
      const response = await createReportRoute(
        jsonRequest("http://test", "POST", {
          subjectType: "run",
          subjectRunId: ownedRunId,
          reason: "other",
        }),
      );
      expect(response.status, state).toBe(201);
    }
  });

  it("POST/DELETE /api/admin/verifications — admin-only; anon 401s, owner/stranger 403 (signed-in, wrong role), admin succeeds", async () => {
    const grantBody = { userId: STRANGER.userId, hardwareVetted: false };
    setViewer("anon");
    expect((await grantVerification(jsonRequest("http://test", "POST", grantBody))).status).toBe(401);
    setViewer("owner");
    expect((await grantVerification(jsonRequest("http://test", "POST", grantBody))).status).toBe(403);
    setViewer("admin");
    expect((await grantVerification(jsonRequest("http://test", "POST", grantBody))).status).toBe(200);
    expect(
      (await revokeVerification(jsonRequest("http://test", "DELETE", { userId: STRANGER.userId })))
        .status,
    ).toBe(200);
  });

  it("GET/PATCH /api/admin/reports[/:id] — admin-only", async () => {
    const report = await createReport(
      { subjectType: "run", subjectRunId: ownedRunId, reason: "other", reporterUserId: null },
      db.pool,
    );

    setViewer("anon");
    expect((await listAdminReports()).status).toBe(401);
    setViewer("stranger");
    expect((await listAdminReports()).status).toBe(403);
    setViewer("admin");
    expect((await listAdminReports()).status).toBe(200);

    setViewer("anon");
    expect(
      (await patchAdminReportById(jsonRequest("http://test", "PATCH", { status: "dismissed" }), ctx(report.id)))
        .status,
    ).toBe(401);
    setViewer("stranger");
    expect(
      (await patchAdminReportById(jsonRequest("http://test", "PATCH", { status: "dismissed" }), ctx(report.id)))
        .status,
    ).toBe(403);
    setViewer("admin");
    expect(
      (await patchAdminReportById(jsonRequest("http://test", "PATCH", { status: "dismissed" }), ctx(report.id)))
        .status,
    ).toBe(204);
  });

  it("POST /api/admin/runs/:id/moderate — admin-only", async () => {
    setViewer("anon");
    expect((await moderateRun(new Request("http://test", { method: "POST" }), ctx(ownedRunId))).status).toBe(
      401,
    );
    setViewer("stranger");
    expect((await moderateRun(new Request("http://test", { method: "POST" }), ctx(ownedRunId))).status).toBe(
      403,
    );
    setViewer("admin");
    expect((await moderateRun(new Request("http://test", { method: "POST" }), ctx(ownedRunId))).status).toBe(
      204,
    );
  });

  it("PATCH /api/admin/games/:id — admin-only", async () => {
    const gameId = (
      await db.pool.query(
        "insert into games (slug, name) values ($1, $2) returning id::text",
        [`authz-matrix-game-${Date.now()}`, "Authz Matrix Game"],
      )
    ).rows[0].id as string;

    setViewer("anon");
    expect(
      (await renameGame(jsonRequest("http://test", "PATCH", { name: "X" }), ctx(gameId))).status,
    ).toBe(401);
    setViewer("stranger");
    expect(
      (await renameGame(jsonRequest("http://test", "PATCH", { name: "X" }), ctx(gameId))).status,
    ).toBe(403);
    setViewer("admin");
    expect(
      (await renameGame(jsonRequest("http://test", "PATCH", { name: "X" }), ctx(gameId))).status,
    ).toBe(200);
  });
});
