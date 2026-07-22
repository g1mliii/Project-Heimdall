/**
 * POST /api/reports integration coverage (§20.5). Real Postgres; the auth
 * seam is mocked, never Clerk. Rate limiting is exercised for real (not
 * mocked) since the create-report scope has its own env-tunable limit.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { RUN_STATUS, RUN_VISIBILITY, validRun } from "@heimdall/shared";
import type { Run } from "@heimdall/shared";
import { insertRun } from "@/lib/db";
import { createTestDb, testDbAvailable, type TestDb } from "@/lib/testing/test-db";

const { getViewer } = vi.hoisted(() => ({ getViewer: { current: async (): Promise<unknown> => null } }));
vi.mock("@/lib/api/auth", () => ({ getViewer: vi.fn(() => getViewer.current()) }));

import { POST as createReportRoute } from "./route";

const canRun = testDbAvailable("reports-api.test");

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

function jsonRequest(body: unknown) {
  return new Request("http://test/api/reports", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe.skipIf(!canRun)("POST /api/reports (§20.5)", () => {
  let db: TestDb;

  beforeAll(async () => {
    db = await createTestDb();
    process.env.DATABASE_URL = db.connectionString;
    process.env.RATE_LIMIT_CREATE_REPORT_PER_HOUR = "10000";
    await insertRun(makeRun("run_report_api"), db.pool);
  }, 240_000);

  afterAll(async () => {
    const globalPool = (globalThis as { __heimdallPgPool?: { end(): Promise<void> } })
      .__heimdallPgPool;
    await globalPool?.end();
    await db?.teardown();
  });

  beforeEach(() => {
    getViewer.current = async () => null;
  });

  it("accepts an anonymous report on a run", async () => {
    const response = await createReportRoute(
      jsonRequest({ subjectType: "run", subjectRunId: "run_report_api", reason: "abusive-name" }),
    );
    expect(response.status).toBe(201);
    const body = (await response.json()) as { status: string; subjectRunId: string };
    expect(body).toMatchObject({ status: "open", subjectRunId: "run_report_api" });
  });

  it("returns 404 for an unknown report subject instead of creating queue spam", async () => {
    const response = await createReportRoute(
      jsonRequest({ subjectType: "run", subjectRunId: "run_report_missing", reason: "other" }),
    );

    expect(response.status).toBe(404);
  });

  it("rejects a payload naming both a run and a game subject id", async () => {
    const response = await createReportRoute(
      jsonRequest({
        subjectType: "run",
        subjectRunId: "run_report_api",
        subjectGameId: "1",
        reason: "other",
      }),
    );
    expect(response.status).toBe(400);
  });

  it("rejects a payload with no subject id at all", async () => {
    const response = await createReportRoute(
      jsonRequest({ subjectType: "game", reason: "other" }),
    );
    expect(response.status).toBe(400);
  });

  it("rejects a game id that cannot fit the Postgres bigint column", async () => {
    const response = await createReportRoute(
      jsonRequest({ subjectType: "game", subjectGameId: "9999999999999999999", reason: "other" }),
    );
    expect(response.status).toBe(400);
  });

  it("records the signed-in reporter's id when one is present", async () => {
    getViewer.current = async () => ({ userId: "user_report_api_reporter", role: "public" as const });
    await db.pool.query(
      "insert into users (id, role) values ($1, 'public') on conflict do nothing",
      ["user_report_api_reporter"],
    );
    const response = await createReportRoute(
      jsonRequest({ subjectType: "run", subjectRunId: "run_report_api", reason: "other" }),
    );
    expect(response.status).toBe(201);
    const { id } = (await response.json()) as { id: string };
    const row = await db.pool.query("select reporter_user_id from reports where id = $1::bigint", [id]);
    expect(row.rows[0]).toEqual({ reporter_user_id: "user_report_api_reporter" });
  });
});
