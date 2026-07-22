/**
 * Webhook route coverage (§20.1b/§20.4): Svix signature verification, event
 * dispatch, and the fail-closed behavior when the signing secret is unset.
 * `lib/env`, `lib/repo/users`, and `lib/repo/erasure` are module-mocked
 * (same convention as `app/api/runs/api.test.ts` mocking `@/lib/r2`) — their
 * own behavior is covered where they live, not here.
 */

import { randomBytes } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Webhook } from "svix";

const WEBHOOK_SECRET = `whsec_${randomBytes(32).toString("base64")}`;

vi.mock("@/lib/env", () => ({
  getAuthEnv: vi.fn(() => ({ CLERK_WEBHOOK_SIGNING_SECRET: WEBHOOK_SECRET })),
}));
vi.mock("@/lib/repo/users", () => ({ syncUserFromClerkEvent: vi.fn(async () => ({})) }));
vi.mock("@/lib/repo/erasure", () => ({ enqueueUserErasureFromClerk: vi.fn(async () => {}) }));

import { getAuthEnv } from "@/lib/env";
import { syncUserFromClerkEvent } from "@/lib/repo/users";
import { enqueueUserErasureFromClerk } from "@/lib/repo/erasure";
import { POST } from "./route";

function signedRequest(body: unknown, secret: string): Request {
  const payload = JSON.stringify(body);
  const id = `msg_${randomBytes(8).toString("hex")}`;
  const timestamp = new Date();
  const signature = new Webhook(secret).sign(id, timestamp, payload);
  return new Request("http://test/api/webhooks/clerk", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "svix-id": id,
      "svix-timestamp": String(Math.floor(timestamp.getTime() / 1000)),
      "svix-signature": signature,
    },
    body: payload,
  });
}

describe("POST /api/webhooks/clerk", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getAuthEnv).mockReturnValue({
      CLERK_WEBHOOK_SIGNING_SECRET: WEBHOOK_SECRET,
    } as ReturnType<typeof getAuthEnv>);
  });

  it("fails closed (503) when no signing secret is configured", async () => {
    vi.mocked(getAuthEnv).mockReturnValue({
      CLERK_WEBHOOK_SIGNING_SECRET: undefined,
    } as ReturnType<typeof getAuthEnv>);
    const response = await POST(
      signedRequest({ type: "user.created", data: { id: "user_1" } }, WEBHOOK_SECRET),
    );
    expect(response.status).toBe(503);
    expect(syncUserFromClerkEvent).not.toHaveBeenCalled();
  });

  it("rejects a request with missing svix headers (400)", async () => {
    const response = await POST(
      new Request("http://test/api/webhooks/clerk", {
        method: "POST",
        body: JSON.stringify({ type: "user.created", data: { id: "user_1" } }),
      }),
    );
    expect(response.status).toBe(400);
  });

  it("rejects an oversized body before Svix verification can buffer it", async () => {
    const request = signedRequest({ type: "user.created", data: { id: "user_oversized" } }, WEBHOOK_SECRET);
    request.headers.set("content-length", String(256 * 1024 + 1));

    const response = await POST(request);

    expect(response.status).toBe(413);
    expect(syncUserFromClerkEvent).not.toHaveBeenCalled();
  });

  it("rejects a bad signature and provisions nothing", async () => {
    const wrongSecret = `whsec_${randomBytes(32).toString("base64")}`;
    const response = await POST(
      signedRequest({ type: "user.created", data: { id: "user_1" } }, wrongSecret),
    );
    expect(response.status).toBe(400);
    expect(syncUserFromClerkEvent).not.toHaveBeenCalled();
  });

  it("rejects a tampered payload even with a validly-signed envelope", async () => {
    const id = `msg_${randomBytes(8).toString("hex")}`;
    const timestamp = new Date();
    const signedPayload = JSON.stringify({ type: "user.created", data: { id: "user_1" } });
    const signature = new Webhook(WEBHOOK_SECRET).sign(id, timestamp, signedPayload);
    const tamperedPayload = JSON.stringify({ type: "user.created", data: { id: "user_evil" } });
    const response = await POST(
      new Request("http://test/api/webhooks/clerk", {
        method: "POST",
        headers: {
          "svix-id": id,
          "svix-timestamp": String(Math.floor(timestamp.getTime() / 1000)),
          "svix-signature": signature,
        },
        body: tamperedPayload,
      }),
    );
    expect(response.status).toBe(400);
    expect(syncUserFromClerkEvent).not.toHaveBeenCalled();
  });

  it("syncs handle + primary email on user.created", async () => {
    const response = await POST(
      signedRequest(
        {
          type: "user.created",
          data: {
            id: "user_1",
            username: "ada",
            primary_email_address_id: "idn_2",
            email_addresses: [
              { id: "idn_1", email_address: "old@example.com" },
              { id: "idn_2", email_address: "ada@example.com" },
            ],
          },
        },
        WEBHOOK_SECRET,
      ),
    );
    expect(response.status).toBe(200);
    expect(syncUserFromClerkEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "user.created",
        userId: "user_1",
        profile: { handle: "ada", email: "ada@example.com" },
        svixId: expect.any(String),
      }),
    );
  });

  it("falls back to null handle/email when Clerk sends none", async () => {
    await POST(signedRequest({ type: "user.updated", data: { id: "user_2" } }, WEBHOOK_SECRET));
    expect(syncUserFromClerkEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "user.updated",
        userId: "user_2",
        profile: { handle: null, email: null },
      }),
    );
  });

  it("triggers erasure as the sole path for user.deleted", async () => {
    const response = await POST(
      signedRequest({ type: "user.deleted", data: { id: "user_3" } }, WEBHOOK_SECRET),
    );
    expect(response.status).toBe(200);
    expect(enqueueUserErasureFromClerk).toHaveBeenCalledWith("user_3", expect.any(String));
    expect(syncUserFromClerkEvent).not.toHaveBeenCalled();
  });

  it("acknowledges unhandled event types without calling either repo", async () => {
    const response = await POST(
      signedRequest({ type: "session.created", data: { id: "sess_1" } }, WEBHOOK_SECRET),
    );
    expect(response.status).toBe(200);
    expect(syncUserFromClerkEvent).not.toHaveBeenCalled();
    expect(enqueueUserErasureFromClerk).not.toHaveBeenCalled();
  });

  it("returns 500 without acknowledging when the handler throws", async () => {
    vi.mocked(enqueueUserErasureFromClerk).mockRejectedValueOnce(new Error("db down"));
    const response = await POST(
      signedRequest({ type: "user.deleted", data: { id: "user_4" } }, WEBHOOK_SECRET),
    );
    expect(response.status).toBe(500);
  });
});
