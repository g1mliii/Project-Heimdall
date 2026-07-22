/**
 * Route-handler integration coverage (plan items 12.1/12.2/12.3/12.6).
 * Route functions are called directly with `new Request(...)` against a real
 * Postgres; R2 and the drain kick are module-mocked (live R2 stays cred-gated
 * in r2.test.ts). DATABASE_URL is pointed at the harness DB before any route
 * runs — the handlers use the default app pool.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  GENERATED_FRAME_TECH,
  INGEST_LIMITS,
  RUN_STATUS,
  RUN_VISIBILITY,
  generateManagementToken,
  hashManagementToken,
  malformedCreateRequests,
  validCreateRunRequest,
} from "@heimdall/shared";
import { createTestDb, testDbAvailable, type TestDb } from "@/lib/testing/test-db";

vi.mock("@/lib/r2", () => ({
  framesUploadObjectKey: (runId: string) => `staging/runs/${runId}.parquet`,
  finalizedFramesObjectKey: (runId: string) => `runs/${runId}/finalized.parquet`,
  presignPut: vi.fn(async () => "https://r2.example.test/put"),
  presignGet: vi.fn(async () => "https://r2.example.test/get"),
  headObject: vi.fn(async () => ({ sizeBytes: 1024, etag: '"staging-etag"' })),
  copyObject: vi.fn(async () => true),
  deleteObject: vi.fn(async () => {}),
  getObject: vi.fn(async () => new Uint8Array()),
  stagingCleanupNotBefore: vi.fn(() => new Date()),
  GET_TTL_SECONDS: 3600,
  MAX_OBJECT_READ_BYTES: 64 * 1024 * 1024,
  PARQUET_CONTENT_TYPE: "application/vnd.apache.parquet",
}));

// The finalize route fires a best-effort drain kick; keep it inert so job-row
// assertions are deterministic (real drain behavior is covered in jobs.test).
vi.mock("@/lib/jobs/drain", () => ({
  drainJobs: vi.fn(async () => ({ claimed: 0, validated: 0, flagged: 0, retried: 0, failed: 0 })),
  cleanupStalePending: vi.fn(async () => 0),
}));

// §20.2: mock our seam, never Clerk (matches the codebase convention). Every
// test starts anonymous; tests exercising ownership opt in per-call via
// setViewer(). requireViewer()'s signed-out shape must be a real NextResponse
// (routes check `instanceof NextResponse`), so it's built with the real class.
const { getViewer, getViewerIdentity, requireViewer } = vi.hoisted(() => ({
  getViewer: { current: async (): Promise<unknown> => null },
  getViewerIdentity: { current: async (): Promise<unknown> => null },
  requireViewer: { current: async (): Promise<unknown> => null },
}));
vi.mock("@/lib/api/auth", () => ({
  getViewer: vi.fn(() => getViewer.current()),
  getViewerIdentity: vi.fn(() => getViewerIdentity.current()),
  requireViewer: vi.fn(() => requireViewer.current()),
}));

import { NextResponse } from "next/server";
import * as r2 from "@/lib/r2";
import * as jobDrain from "@/lib/jobs/drain";
import { listRunsForUser } from "@/lib/repo/runs";
import { POST as createRun } from "./route";
import { DELETE as deleteRunRoute, GET as getRun, PATCH as patchRun } from "./[id]/route";
import { POST as finalizeRun } from "./[id]/finalize/route";
import { GET as getFrames } from "./[id]/frames/route";
import { POST as claimRun } from "./[id]/claim/route";

const OWNER = { userId: "user_owner", role: "public" as const };
const STRANGER = { userId: "user_stranger", role: "public" as const };
const ADMIN = { userId: "user_admin", role: "admin" as const };

const UNAUTHORIZED = () =>
  NextResponse.json({ error: { code: "auth-required", message: "sign in required" } }, { status: 401 });

/** Keep getViewer()/requireViewer() in sync — every route uses one or the other. */
function setViewer(viewer: typeof OWNER | typeof STRANGER | typeof ADMIN | null) {
  getViewer.current = async () => viewer;
  getViewerIdentity.current = async () => (viewer ? { userId: viewer.userId } : null);
  requireViewer.current = async () => viewer ?? UNAUTHORIZED();
}

const canRun = testDbAvailable("api.test");
const BENCHMARK_SET_ID = "f1dca0e4-2bba-4b47-81dc-a928cec52058";
const BENCHMARK_SET_SECRET = "a".repeat(43);

function jsonRequest(url: string, method: string, body: unknown, headers?: Record<string, string>) {
  return new Request(url, {
    method,
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

function ctx(id: string) {
  return { params: Promise.resolve({ id }) };
}

async function createValidRun(): Promise<{ id: string; uploadObjectKey: string }> {
  const response = await createRun(
    jsonRequest("http://test/api/runs", "POST", validCreateRunRequest),
  );
  expect(response.status).toBe(201);
  const body = (await response.json()) as { id: string; uploadObjectKey: string };
  return body;
}

async function finalize(
  id: string,
  overrides: Record<string, unknown> = {},
): Promise<Response> {
  const managementTokenHash = await hashManagementToken(generateManagementToken());
  return finalizeRun(
    jsonRequest(`http://test/api/runs/${id}/finalize`, "POST", {
      uploadObjectKey: `staging/runs/${id}.parquet`,
      visibility: RUN_VISIBILITY.unlisted,
      managementTokenHash,
      ...overrides,
    }),
    ctx(id),
  );
}

describe.skipIf(!canRun)("ingest API routes (§11)", () => {
  let db: TestDb;

  beforeAll(async () => {
    db = await createTestDb();
    // Routes use the default app pool — point it at the harness DB. The pool
    // is created lazily on first use, so setting env here is early enough.
    process.env.DATABASE_URL = db.connectionString;
    // Keep the suite clear of its own rate limits.
    process.env.RATE_LIMIT_CREATE_RUNS_PER_HOUR = "10000";
    process.env.RATE_LIMIT_FINALIZE_PER_HOUR = "10000";
    process.env.RATE_LIMIT_DELETE_PER_HOUR = "10000";
    // runs.user_id has an FK to users(id) — the real getViewer() JIT-provisions
    // via ensureUser() before returning a Viewer, but the mock here bypasses
    // that, so the ownership tests need these rows to already exist.
    await db.pool.query(
      `insert into users (id, role) values ($1, 'public'), ($2, 'public'), ($3, 'admin')
       on conflict (id) do nothing`,
      [OWNER.userId, STRANGER.userId, ADMIN.userId],
    );
  }, 240_000);

  afterAll(async () => {
    // The routes' global pool holds connections to the harness DB; close it
    // so teardown (schema drop / container stop) doesn't hang.
    const globalPool = (globalThis as { __heimdallPgPool?: { end(): Promise<void> } })
      .__heimdallPgPool;
    await globalPool?.end();
    await db?.teardown();
  });

  // beforeEach, not afterEach: the hoisted mock's raw initial default
  // (before any setViewer() call) returns bare `null`, not a proper
  // NextResponse 401 — normalize up front regardless of test order (see
  // ../account/api.test.ts for the failure this avoids).
  beforeEach(() => {
    setViewer(null);
  });

  it("POST /api/runs: creates a pending row and returns a presigned PUT (12.2)", async () => {
    const { id, uploadObjectKey } = await createValidRun();
    expect(uploadObjectKey).toBe(`staging/runs/${id}.parquet`);
    expect(r2.presignPut).toHaveBeenCalledWith(uploadObjectKey, {
      contentLengthBytes: validCreateRunRequest.parquetByteLength,
    });

    const rows = await db.pool.query(
      "select status, visibility, frames_object_key from runs where id = $1",
      [id],
    );
    expect(rows.rows[0]).toEqual({
      status: RUN_STATUS.pending,
      visibility: RUN_VISIBILITY.unlisted,
      frames_object_key: null,
    });
  });

  it("POST /api/runs: strips client-asserted canonical hardware ids (§11.9)", async () => {
    const response = await createRun(
      jsonRequest("http://test/api/runs", "POST", {
        ...validCreateRunRequest,
        hardware: {
          ...validCreateRunRequest.hardware,
          canonicalGpuId: "999",
          canonicalCpuId: "998",
        },
      }),
    );
    expect(response.status).toBe(201);
    const { id } = (await response.json()) as { id: string };
    const rows = await db.pool.query(
      "select gpu_hardware_id, cpu_hardware_id from runs where id = $1",
      [id],
    );
    expect(rows.rows[0]).toEqual({ gpu_hardware_id: null, cpu_hardware_id: null });
  });

  it("POST /api/runs: never persists generated frames as native metadata", async () => {
    const response = await createRun(
      jsonRequest("http://test/api/runs", "POST", {
        ...validCreateRunRequest,
        summary: { ...validCreateRunRequest.summary, generatedFramePct: 0.5 },
        generatedFrameTech: GENERATED_FRAME_TECH.none,
      }),
    );
    expect(response.status).toBe(201);
    const { id } = (await response.json()) as { id: string };
    const rows = await db.pool.query("select generated_frame_tech from runs where id = $1", [id]);
    expect(rows.rows[0]?.generated_frame_tech).toBe(GENERATED_FRAME_TECH.unknown);
  });

  it("POST /api/runs: retains opaque benchmark-set membership and only its hash", async () => {
    const response = await createRun(
      jsonRequest("http://test/api/runs", "POST", {
        ...validCreateRunRequest,
        benchmarkSetId: BENCHMARK_SET_ID,
        benchmarkSetSecret: BENCHMARK_SET_SECRET,
        isWarmup: true,
      }),
    );
    expect(response.status).toBe(201);
    const { id } = (await response.json()) as { id: string };
    const rows = await db.pool.query(
      `select r.benchmark_set_id, r.is_warmup, b.secret_hash
         from runs r join benchmark_sets b on b.id = r.benchmark_set_id
        where r.id = $1`,
      [id],
    );
    expect(rows.rows[0]).toEqual({
      benchmark_set_id: BENCHMARK_SET_ID,
      is_warmup: true,
      secret_hash: await hashManagementToken(BENCHMARK_SET_SECRET),
    });
  });

  it("POST /api/runs: refuses a colliding benchmark-set id with another browser key", async () => {
    const setId = "c90ef4a9-3d8d-4216-b48b-9080bdaa58d3";
    const first = await createRun(
      jsonRequest("http://test/api/runs", "POST", {
        ...validCreateRunRequest,
        benchmarkSetId: setId,
        benchmarkSetSecret: "b".repeat(43),
      }),
    );
    expect(first.status).toBe(201);

    vi.mocked(r2.presignPut).mockClear();
    const conflict = await createRun(
      jsonRequest("http://test/api/runs", "POST", {
        ...validCreateRunRequest,
        benchmarkSetId: setId,
        benchmarkSetSecret: "c".repeat(43),
      }),
    );
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toMatchObject({
      error: { code: "benchmark-set-secret-mismatch" },
    });
    expect(r2.presignPut).not.toHaveBeenCalled();
  });

  it("POST /api/runs: rejects malformed payloads with 400 BEFORE presigning (12.1, §11.10)", async () => {
    vi.mocked(r2.presignPut).mockClear();
    for (const [name, payload] of Object.entries(malformedCreateRequests)) {
      if (name === "negativeFrameTime") {
        continue; // a frame-level fixture, not a create payload
      }
      const response = await createRun(jsonRequest("http://test/api/runs", "POST", payload));
      expect(response.status, `${name} → 400`).toBe(400);
      const body = (await response.json()) as { error: { code: string } };
      expect(body.error.code).toBe("invalid-request");
    }
    expect(r2.presignPut).not.toHaveBeenCalled();

    const notJson = await createRun(
      new Request("http://test/api/runs", { method: "POST", body: "not json{" }),
    );
    expect(notJson.status).toBe(400);
  });

  it("POST /api/runs: rejects private visibility from an anonymous caller (§20.2d)", async () => {
    vi.mocked(r2.presignPut).mockClear();
    const response = await createRun(
      jsonRequest("http://test/api/runs", "POST", {
        ...validCreateRunRequest,
        visibility: RUN_VISIBILITY.private,
      }),
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: { code: "auth-required-for-private" },
    });
    expect(r2.presignPut).not.toHaveBeenCalled();
  });

  it("POST /api/runs: a signed-in caller owns a private run; a stranger and an anonymous reader both 404 (§20.2)", async () => {
    setViewer(OWNER);
    const response = await createRun(
      jsonRequest("http://test/api/runs", "POST", {
        ...validCreateRunRequest,
        visibility: RUN_VISIBILITY.private,
      }),
    );
    expect(response.status).toBe(201);
    const { id } = (await response.json()) as { id: string };

    const ownerRow = await db.pool.query("select user_id from runs where id = $1", [id]);
    expect(ownerRow.rows[0]).toEqual({ user_id: OWNER.userId });

    // Owner sees it.
    expect((await getRun(new Request("http://test"), ctx(id))).status).toBe(200);

    // A stranger and an anonymous reader both get an indistinguishable 404.
    setViewer(STRANGER);
    expect((await getRun(new Request("http://test"), ctx(id))).status).toBe(404);
    setViewer(null);
    expect((await getRun(new Request("http://test"), ctx(id))).status).toBe(404);
  });

  it("finalize: an anonymous run cannot finalize as private, even if the finalizer happens to be signed in (§20.2d)", async () => {
    const { id } = await createValidRun(); // anonymous create — no owner
    setViewer(OWNER);
    const response = await finalize(id, { visibility: RUN_VISIBILITY.private });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: { code: "auth-required-for-private" },
    });
  });

  it("finalize: 404s when the finalizer isn't the run's owner (ownership is fixed at create)", async () => {
    setViewer(OWNER);
    const { id } = await createValidRun();

    setViewer(STRANGER);
    const response = await finalize(id);
    expect(response.status).toBe(404);
  });

  it("finalize: HEAD-validates, resolves canonical ids, enqueues exactly one job (12.2/12.3)", async () => {
    vi.mocked(jobDrain.drainJobs).mockClear();
    const { id } = await createValidRun();
    const tokenHash = await hashManagementToken(generateManagementToken());

    const response = await finalize(id, { managementTokenHash: tokenHash });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ id, status: RUN_STATUS.pending });

    const run = await db.pool.query(
      `select frames_object_key, game_id, gpu_hardware_id, cpu_hardware_id,
              anonymous_management_token_hash
         from runs where id = $1`,
      [id],
    );
    expect(r2.copyObject).toHaveBeenCalledWith(
      `staging/runs/${id}.parquet`,
      `runs/${id}/finalized.parquet`,
      { sourceEtag: '"staging-etag"' },
    );
    expect(run.rows[0]?.frames_object_key).toBe(`runs/${id}/finalized.parquet`);
    expect(run.rows[0]?.anonymous_management_token_hash).toBe(tokenHash);
    // §11.9: canonical ids resolved server-side (match-or-create really ran).
    expect(run.rows[0]?.game_id).not.toBeNull();
    expect(run.rows[0]?.gpu_hardware_id).not.toBeNull();
    expect(run.rows[0]?.cpu_hardware_id).not.toBeNull();

    const jobs = await db.pool.query(
      "select status from verification_jobs where run_id = $1",
      [id],
    );
    expect(jobs.rows).toEqual([{ status: "pending" }]);
    const cleanup = await db.pool.query(
      "select object_key, attempts, last_error from staging_cleanup_jobs where run_id = $1",
      [id],
    );
    expect(cleanup.rows).toEqual([
      { object_key: `staging/runs/${id}.parquet`, attempts: 0, last_error: null },
    ]);
    expect(jobDrain.drainJobs).toHaveBeenCalledWith({ maxJobs: 1 });

    // Re-finalize: 409, still exactly one job row (12.3).
    const again = await finalize(id);
    expect(again.status).toBe(409);
    expect((await db.pool.query("select 1 from verification_jobs where run_id = $1", [id])).rows)
      .toHaveLength(1);
  });

  it("finalize: requires a management token hash before copying", async () => {
    const { id } = await createValidRun();
    vi.mocked(r2.copyObject).mockClear();

    const response = await finalize(id, { managementTokenHash: undefined });

    expect(response.status).toBe(400);
    expect((await response.json()).error.code).toBe("invalid-request");
    expect(r2.copyObject).not.toHaveBeenCalled();
  });

  it("finalize: surfaces failure to clean up an untracked finalized copy", async () => {
    const managementTokenHash = await hashManagementToken(generateManagementToken());
    const first = await createValidRun();
    expect((await finalize(first.id, { managementTokenHash })).status).toBe(200);

    const second = await createValidRun();
    const copiedKey = `runs/${second.id}/finalized.parquet`;
    vi.mocked(r2.deleteObject).mockImplementation(async (key) => {
      if (key === copiedKey) {
        throw new Error("simulated R2 cleanup outage");
      }
    });
    try {
      const response = await finalize(second.id, { managementTokenHash });
      expect(response.status).toBe(502);
      expect((await response.json()).error.code).toBe("storage-cleanup-failed");
      expect(r2.deleteObject).toHaveBeenCalledWith(copiedKey);
      const row = await db.pool.query(
        "select status, frames_object_key from runs where id = $1",
        [second.id],
      );
      expect(row.rows[0]).toEqual({ status: RUN_STATUS.pending, frames_object_key: null });
    } finally {
      vi.mocked(r2.deleteObject).mockResolvedValue(undefined);
    }
  });

  it("finalize: retains durable staging cleanup when immediate deletion fails", async () => {
    const { id } = await createValidRun();
    vi.mocked(r2.deleteObject).mockRejectedValueOnce(new Error("simulated R2 outage"));

    const response = await finalize(id);

    expect(response.status).toBe(200);
    expect(
      (
        await db.pool.query(
          "select object_key from staging_cleanup_jobs where run_id = $1",
          [id],
        )
      ).rows,
    ).toEqual([{ object_key: `staging/runs/${id}.parquet` }]);
  });

  it("finalize: 403 on a foreign object key, 404 on unknown run", async () => {
    const { id } = await createValidRun();
    const hijack = await finalize(id, { uploadObjectKey: "staging/runs/other.parquet" });
    expect(hijack.status).toBe(403);

    const missing = await finalize("does_not_exist");
    expect(missing.status).toBe(404);
  });

  it("finalize: 409 when the object was never uploaded; 413 + delete when oversized (12.1, §11.10)", async () => {
    const { id } = await createValidRun();
    vi.mocked(r2.headObject).mockResolvedValueOnce(null);
    expect((await finalize(id)).status).toBe(409);

    vi.mocked(r2.headObject).mockResolvedValueOnce({
      sizeBytes: INGEST_LIMITS.maxParquetBytes + 1,
      etag: '"oversized"',
    });
    vi.mocked(r2.deleteObject).mockClear();
    const oversized = await finalize(id);
    expect(oversized.status).toBe(413);
    expect(r2.deleteObject).toHaveBeenCalledWith(`staging/runs/${id}.parquet`);
  });

  it("finalize: rejects a staging overwrite between HEAD and the immutable copy", async () => {
    const { id } = await createValidRun();
    vi.mocked(r2.copyObject).mockResolvedValueOnce(false);

    const response = await finalize(id);
    expect(response.status).toBe(409);
    expect((await response.json()).error.code).toBe("upload-changed");
    const run = await db.pool.query("select frames_object_key from runs where id = $1", [id]);
    expect(run.rows[0]?.frames_object_key).toBeNull();
    const jobs = await db.pool.query("select 1 from verification_jobs where run_id = $1", [id]);
    expect(jobs.rows).toHaveLength(0);
  });

  it("GET run + frames: unlisted is link-scoped; pending-upload frames 409", async () => {
    const { id } = await createValidRun();

    const beforeFinalize = await getRun(new Request("http://test"), ctx(id));
    expect(beforeFinalize.status).toBe(200);
    const body = (await beforeFinalize.json()) as Record<string, unknown>;
    expect(body.id).toBe(id);
    // Secrets never ride the read path.
    expect(JSON.stringify(body)).not.toContain("token");

    expect((await getFrames(new Request("http://test"), ctx(id))).status).toBe(409);

    await finalize(id);
    const frames = await getFrames(new Request("http://test"), ctx(id));
    expect(frames.status).toBe(200);
    expect(await frames.json()).toEqual({
      url: "https://r2.example.test/get",
      expiresInSeconds: 3600,
    });

    expect((await getRun(new Request("http://test"), ctx("nope"))).status).toBe(404);
  });

  it("GET run: never includes ownerId — a raw Clerk user id has no reason to reach any viewer (§20.3)", async () => {
    setViewer(OWNER);
    const { id } = await createValidRun();
    await finalize(id);

    // Even the owner's own view must not leak it — nothing reads it from here.
    const response = await getRun(new Request("http://test"), ctx(id));
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body).not.toHaveProperty("ownerId");

    const row = await db.pool.query("select user_id from runs where id = $1", [id]);
    expect(row.rows[0]).toEqual({ user_id: OWNER.userId }); // sanity: it IS set server-side
  });

  it("GET run: private, flagged, and hidden runs 404 for a stranger; owner sees private/flagged but never hidden (§20.2c)", async () => {
    setViewer(OWNER);
    const { id } = await createValidRun();
    await db.pool.query("update runs set visibility = 'private', user_id = $2 where id = $1", [
      id,
      OWNER.userId,
    ]);
    expect((await getRun(new Request("http://test"), ctx(id))).status).toBe(200);
    setViewer(STRANGER);
    expect((await getRun(new Request("http://test"), ctx(id))).status).toBe(404);
    setViewer(null);
    expect((await getRun(new Request("http://test"), ctx(id))).status).toBe(404);

    await db.pool.query(
      "update runs set visibility = 'unlisted', status = 'flagged' where id = $1",
      [id],
    );
    setViewer(OWNER);
    expect((await getRun(new Request("http://test"), ctx(id))).status).toBe(200);
    setViewer(STRANGER);
    expect((await getRun(new Request("http://test"), ctx(id))).status).toBe(404);
    expect((await getFrames(new Request("http://test"), ctx(id))).status).toBe(404);

    // hidden (the deletion tombstone) is invisible to EVERYONE, even the owner.
    await db.pool.query(
      "update runs set visibility = 'unlisted', status = 'hidden' where id = $1",
      [id],
    );
    setViewer(OWNER);
    expect((await getRun(new Request("http://test"), ctx(id))).status).toBe(404);
  });

  it("DELETE: wrong/missing token 404s and leaves the run; right token removes row + object (12.6)", async () => {
    const { id } = await createValidRun();
    const token = generateManagementToken();
    await finalize(id, { managementTokenHash: await hashManagementToken(token) });

    const noToken = await deleteRunRoute(
      new Request("http://test", { method: "DELETE" }),
      ctx(id),
    );
    expect(noToken.status).toBe(404);
    const wrongToken = await deleteRunRoute(
      new Request("http://test", {
        method: "DELETE",
        headers: { authorization: `Bearer ${generateManagementToken()}` },
      }),
      ctx(id),
    );
    expect(wrongToken.status).toBe(404);
    expect((await db.pool.query("select 1 from runs where id = $1", [id])).rows).toHaveLength(1);

    vi.mocked(r2.deleteObject).mockClear();
    const success = await deleteRunRoute(
      new Request("http://test", {
        method: "DELETE",
        headers: { authorization: `Bearer ${token}` },
      }),
      ctx(id),
    );
    expect(success.status).toBe(204);
    expect(r2.deleteObject).toHaveBeenCalledWith(`runs/${id}/finalized.parquet`);
    expect((await db.pool.query("select 1 from runs where id = $1", [id])).rows).toHaveLength(0);

    // Idempotent from the caller's view: the run is simply gone now.
    const repeat = await deleteRunRoute(
      new Request("http://test", {
        method: "DELETE",
        headers: { authorization: `Bearer ${token}` },
      }),
      ctx(id),
    );
    expect(repeat.status).toBe(404);
  });

  it("DELETE: the run's owner can delete without a token; a non-owner without a token 404s; an admin can too (§20.2)", async () => {
    setViewer(OWNER);
    const { id: ownedId } = await createValidRun();
    await finalize(ownedId);

    setViewer(STRANGER);
    const strangerAttempt = await deleteRunRoute(
      new Request("http://test", { method: "DELETE" }),
      ctx(ownedId),
    );
    expect(strangerAttempt.status).toBe(404);
    expect(
      (await db.pool.query("select 1 from runs where id = $1", [ownedId])).rows,
    ).toHaveLength(1);

    setViewer(OWNER);
    const ownerDelete = await deleteRunRoute(
      new Request("http://test", { method: "DELETE" }),
      ctx(ownedId),
    );
    expect(ownerDelete.status).toBe(204);
    expect(
      (await db.pool.query("select 1 from runs where id = $1", [ownedId])).rows,
    ).toHaveLength(0);

    // An admin can delete someone else's run too.
    setViewer(OWNER);
    const { id: secondId } = await createValidRun();
    await finalize(secondId);
    setViewer(ADMIN);
    const adminDelete = await deleteRunRoute(
      new Request("http://test", { method: "DELETE" }),
      ctx(secondId),
    );
    expect(adminDelete.status).toBe(204);
  });

  it("PATCH: rejects an anonymous caller (401) and a non-owner (404); the owner can switch visibility (§20.2)", async () => {
    setViewer(OWNER);
    const { id } = await createValidRun();

    setViewer(null);
    const anon = await patchRun(
      jsonRequest("http://test", "PATCH", { visibility: RUN_VISIBILITY.public }),
      ctx(id),
    );
    expect(anon.status).toBe(401);

    setViewer(STRANGER);
    const stranger = await patchRun(
      jsonRequest("http://test", "PATCH", { visibility: RUN_VISIBILITY.public }),
      ctx(id),
    );
    expect(stranger.status).toBe(404);

    setViewer(OWNER);
    const ownerPatch = await patchRun(
      jsonRequest("http://test", "PATCH", { visibility: RUN_VISIBILITY.private }),
      ctx(id),
    );
    expect(ownerPatch.status).toBe(200);
    expect(await ownerPatch.json()).toEqual({ id, visibility: RUN_VISIBILITY.private });
    const row = await db.pool.query("select visibility from runs where id = $1", [id]);
    expect(row.rows[0]).toEqual({ visibility: RUN_VISIBILITY.private });
  });

  it("claim: rejects anonymous (401), wrong token (404), and an already-owned run even with its valid token (404); the right token attaches ownership and is single-use (§20.2e)", async () => {
    const token = generateManagementToken();
    const { id: anonId } = await createValidRun();
    await finalize(anonId, { managementTokenHash: await hashManagementToken(token) });

    const anonAttempt = await claimRun(
      new Request("http://test", { method: "POST" }),
      ctx(anonId),
    );
    expect(anonAttempt.status).toBe(401);

    setViewer(OWNER);
    const noToken = await claimRun(new Request("http://test", { method: "POST" }), ctx(anonId));
    expect(noToken.status).toBe(404);

    const wrongToken = await claimRun(
      new Request("http://test", {
        method: "POST",
        headers: { authorization: `Bearer ${generateManagementToken()}` },
      }),
      ctx(anonId),
    );
    expect(wrongToken.status).toBe(404);

    const success = await claimRun(
      new Request("http://test", {
        method: "POST",
        headers: { authorization: `Bearer ${token}` },
      }),
      ctx(anonId),
    );
    expect(success.status).toBe(204);
    const claimed = await db.pool.query(
      "select user_id, anonymous_management_token_hash from runs where id = $1",
      [anonId],
    );
    expect(claimed.rows[0]).toEqual({
      user_id: OWNER.userId,
      anonymous_management_token_hash: null,
    });

    // The claimed run now shows up in the new owner's "My runs".
    const ownerRuns = await listRunsForUser(OWNER.userId, db.pool);
    expect(ownerRuns.runs.some((r) => r.id === anonId)).toBe(true);

    // The old anonymous management token can no longer delete the run — the
    // DELETE route's token path requires a non-null stored hash, and claim
    // cleared it. Anonymous (no viewer), so this isolates the token-only
    // path from the now-also-true "owner can delete without a token" path.
    setViewer(null);
    const deleteWithOldToken = await deleteRunRoute(
      new Request("http://test", {
        method: "DELETE",
        headers: { authorization: `Bearer ${token}` },
      }),
      ctx(anonId),
    );
    expect(deleteWithOldToken.status).toBe(404);
    expect((await db.pool.query("select 1 from runs where id = $1", [anonId])).rows).toHaveLength(1);

    // Single-use: the same (now-cleared) token can't claim it again.
    setViewer(STRANGER);
    const replay = await claimRun(
      new Request("http://test", {
        method: "POST",
        headers: { authorization: `Bearer ${token}` },
      }),
      ctx(anonId),
    );
    expect(replay.status).toBe(404);

    // An already-owned run 404s even against its own valid token — a
    // signed-in upload still gets a management token, but claim is only for
    // attaching an owner, not for re-claiming an already-owned run.
    setViewer(OWNER);
    const ownedToken = generateManagementToken();
    const { id: ownedId } = await createValidRun();
    await finalize(ownedId, { managementTokenHash: await hashManagementToken(ownedToken) });
    setViewer(STRANGER);
    const alreadyOwned = await claimRun(
      new Request("http://test", {
        method: "POST",
        headers: { authorization: `Bearer ${ownedToken}` },
      }),
      ctx(ownedId),
    );
    expect(alreadyOwned.status).toBe(404);
  });

  it("DELETE: storage failure tombstones the run so the delete can be retried", async () => {
    const { id } = await createValidRun();
    const token = generateManagementToken();
    await finalize(id, { managementTokenHash: await hashManagementToken(token) });

    vi.mocked(r2.deleteObject).mockRejectedValueOnce(new Error("r2 down"));
    const failed = await deleteRunRoute(
      new Request("http://test", {
        method: "DELETE",
        headers: { authorization: `Bearer ${token}` },
      }),
      ctx(id),
    );
    expect(failed.status).toBe(502);
    expect(
      (await db.pool.query("select status from runs where id = $1", [id])).rows,
    ).toEqual([{ status: RUN_STATUS.hidden }]);
    expect((await getRun(new Request("http://test"), ctx(id))).status).toBe(404);

    const retry = await deleteRunRoute(
      new Request("http://test", {
        method: "DELETE",
        headers: { authorization: `Bearer ${token}` },
      }),
      ctx(id),
    );
    expect(retry.status).toBe(204);
    expect((await db.pool.query("select 1 from runs where id = $1", [id])).rows).toEqual([]);
  });

  it("pins the shared byte limit to the R2 read cap (worker must read what the API accepts)", () => {
    expect(INGEST_LIMITS.maxParquetBytes).toBe(64 * 1024 * 1024);
  });
});
