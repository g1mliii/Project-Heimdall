/**
 * Route-handler integration coverage for the account surface (§20.2):
 * GET /api/account/runs ("My runs") and PATCH /api/account (handle edit).
 * Real Postgres; the auth seam is mocked, never Clerk.
 */

import { NextResponse } from "next/server";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  RUN_STATUS,
  RUN_VISIBILITY,
  generateManagementToken,
  hashManagementToken,
  validCreateRunRequest,
} from "@heimdall/shared";
import { createTestDb, testDbAvailable, type TestDb } from "@/lib/testing/test-db";

vi.mock("@/lib/r2", () => ({
  framesUploadObjectKey: (runId: string) => `staging/runs/${runId}.parquet`,
  finalizedFramesObjectKey: (runId: string) => `runs/${runId}/finalized.parquet`,
  presignPut: vi.fn(async () => "https://r2.example.test/put"),
  headObject: vi.fn(async () => ({ sizeBytes: 1024, etag: '"staging-etag"' })),
  copyObject: vi.fn(async () => true),
  deleteObject: vi.fn(async () => {}),
  stagingCleanupNotBefore: vi.fn(() => new Date()),
}));
vi.mock("@/lib/jobs/drain", () => ({
  drainJobs: vi.fn(async () => ({ claimed: 0, validated: 0, flagged: 0, retried: 0, failed: 0 })),
  cleanupStalePending: vi.fn(async () => 0),
}));

const { getViewer, requireViewer } = vi.hoisted(() => ({
  getViewer: { current: async (): Promise<unknown> => null },
  requireViewer: { current: async (): Promise<unknown> => null },
}));
vi.mock("@/lib/api/auth", () => ({
  getViewer: vi.fn(() => getViewer.current()),
  requireViewer: vi.fn(() => requireViewer.current()),
}));

import { GET as getAccountRuns } from "./runs/route";
import { PATCH as patchAccount } from "./route";
import { POST as createRun } from "../runs/route";
import { POST as finalizeRun } from "../runs/[id]/finalize/route";

const OWNER = { userId: "user_account_owner", role: "public" as const };
const UNAUTHORIZED = () =>
  NextResponse.json({ error: { code: "auth-required", message: "sign in required" } }, { status: 401 });

function setViewer(viewer: typeof OWNER | null) {
  getViewer.current = async () => viewer;
  requireViewer.current = async () => viewer ?? UNAUTHORIZED();
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

const canRun = testDbAvailable("account-api.test");

describe.skipIf(!canRun)("account API routes (§20.2)", () => {
  let db: TestDb;

  beforeAll(async () => {
    db = await createTestDb();
    process.env.DATABASE_URL = db.connectionString;
    process.env.RATE_LIMIT_CREATE_RUNS_PER_HOUR = "10000";
    process.env.RATE_LIMIT_FINALIZE_PER_HOUR = "10000";
    await db.pool.query("insert into users (id, role) values ($1, 'public') on conflict do nothing", [
      OWNER.userId,
    ]);
  }, 240_000);

  afterAll(async () => {
    const globalPool = (globalThis as { __heimdallPgPool?: { end(): Promise<void> } })
      .__heimdallPgPool;
    await globalPool?.end();
    await db?.teardown();
  });

  // beforeEach, not afterEach: the hoisted mock's raw initial default
  // (before any setViewer() call) returns bare `null`, not a proper
  // NextResponse 401 — a test that checks anonymous-401 behavior FIRST would
  // otherwise crash instead of getting 401. This normalizes state up front
  // regardless of test order.
  beforeEach(() => {
    setViewer(null);
  });

  async function createAndFinalizeOwnedRun(): Promise<string> {
    const response = await createRun(
      jsonRequest("http://test/api/runs", "POST", validCreateRunRequest),
    );
    const { id } = (await response.json()) as { id: string };
    await finalizeRun(
      jsonRequest(`http://test/api/runs/${id}/finalize`, "POST", {
        uploadObjectKey: `staging/runs/${id}.parquet`,
        visibility: RUN_VISIBILITY.unlisted,
        managementTokenHash: await hashManagementToken(generateManagementToken()),
      }),
      ctx(id),
    );
    return id;
  }

  it("GET /api/account/runs: 401s anonymous; lists only the caller's own runs, newest first", async () => {
    const anon = await getAccountRuns();
    expect(anon.status).toBe(401);

    setViewer(OWNER);
    const firstId = await createAndFinalizeOwnedRun();
    const secondId = await createAndFinalizeOwnedRun();

    const response = await getAccountRuns();
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      runs: Array<{ id: string; status: string }>;
      nextCursor: string | null;
    };
    const ids = body.runs.map((r) => r.id);
    expect(ids.indexOf(secondId)).toBeLessThan(ids.indexOf(firstId));
    expect(body.runs.every((r) => r.status === RUN_STATUS.pending || r.status === RUN_STATUS.validated)).toBe(
      true,
    );
  });

  it("PATCH /api/account: 401s anonymous; rejects an invalid/reserved handle (400); updates a valid one", async () => {
    const anon = await patchAccount(jsonRequest("http://test/api/account", "PATCH", { handle: "ok-handle" }));
    expect(anon.status).toBe(401);

    setViewer(OWNER);
    const reserved = await patchAccount(
      jsonRequest("http://test/api/account", "PATCH", { handle: "admin" }),
    );
    expect(reserved.status).toBe(400);

    const tooShort = await patchAccount(
      jsonRequest("http://test/api/account", "PATCH", { handle: "ab" }),
    );
    expect(tooShort.status).toBe(400);

    const ok = await patchAccount(
      jsonRequest("http://test/api/account", "PATCH", { handle: "ada-lovelace" }),
    );
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ id: OWNER.userId, handle: "ada-lovelace" });
    const row = await db.pool.query("select handle from users where id = $1", [OWNER.userId]);
    expect(row.rows[0]).toEqual({ handle: "ada-lovelace" });
  });

  it("PATCH /api/account: a taken handle 409s instead of erroring", async () => {
    setViewer(OWNER);
    await patchAccount(jsonRequest("http://test/api/account", "PATCH", { handle: "taken-handle" }));

    const other = { userId: "user_account_other", role: "public" as const };
    await db.pool.query("insert into users (id, role) values ($1, 'public') on conflict do nothing", [
      other.userId,
    ]);
    setViewer(other);
    const conflict = await patchAccount(
      jsonRequest("http://test/api/account", "PATCH", { handle: "taken-handle" }),
    );
    expect(conflict.status).toBe(409);
  });
});
