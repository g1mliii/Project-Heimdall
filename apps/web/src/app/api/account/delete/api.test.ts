/**
 * POST /api/account/delete coverage (§20.4). This route never runs the
 * erasure cascade itself — it only asks Clerk to delete the user; the
 * `user.deleted` webhook is the sole trigger for durable erasure (see
 * lib/repo/erasure.test.ts for that cascade's own coverage). This test
 * asserts the route's actual job: auth-gate, call Clerk, and nothing else.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { requireViewer, getAuthEnv } = vi.hoisted(() => ({
  requireViewer: { current: async (): Promise<unknown> => null },
  getAuthEnv: {
    current: (): { CLERK_WEBHOOK_SIGNING_SECRET?: string } => ({
      CLERK_WEBHOOK_SIGNING_SECRET: "whsec_test",
    }),
  },
}));
vi.mock("@/lib/api/auth", () => ({ requireViewer: vi.fn(() => requireViewer.current()) }));
vi.mock("@/lib/env", () => ({ getAuthEnv: vi.fn(() => getAuthEnv.current()) }));

const deleteUser = vi.fn(async () => ({}));
vi.mock("@clerk/nextjs/server", () => ({
  clerkClient: vi.fn(async () => ({ users: { deleteUser } })),
}));

import { NextResponse } from "next/server";
import { POST } from "./route";

const VIEWER = { userId: "user_delete_me", role: "public" as const };
const UNAUTHORIZED = () =>
  NextResponse.json({ error: { code: "auth-required", message: "sign in required" } }, { status: 401 });

describe("POST /api/account/delete (§20.4)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    requireViewer.current = async () => VIEWER;
    getAuthEnv.current = () => ({ CLERK_WEBHOOK_SIGNING_SECRET: "whsec_test" });
  });

  afterEach(() => {
    requireViewer.current = async () => null;
    getAuthEnv.current = () => ({ CLERK_WEBHOOK_SIGNING_SECRET: "whsec_test" });
  });

  it("401s an anonymous caller without touching Clerk", async () => {
    requireViewer.current = async () => UNAUTHORIZED();
    const response = await POST();
    expect(response.status).toBe(401);
    expect(deleteUser).not.toHaveBeenCalled();
  });

  it("asks Clerk to delete the caller's own account, never someone else's id", async () => {
    const response = await POST();
    expect(response.status).toBe(202);
    expect(deleteUser).toHaveBeenCalledWith(VIEWER.userId);
    expect(deleteUser).toHaveBeenCalledTimes(1);
  });

  it("returns 503 without deleting the Clerk account when the erasure webhook is unavailable", async () => {
    getAuthEnv.current = () => ({ CLERK_WEBHOOK_SIGNING_SECRET: undefined });

    const response = await POST();

    expect(response.status).toBe(503);
    expect(deleteUser).not.toHaveBeenCalled();
  });

  it("returns 500 if the Clerk call fails, without swallowing the error silently", async () => {
    deleteUser.mockRejectedValueOnce(new Error("clerk down"));
    const response = await POST();
    expect(response.status).toBe(500);
  });
});
