/**
 * POST /api/webhooks/clerk (§20.1b/§20.4) — Svix-verified Clerk webhook.
 * `user.created`/`user.updated` sync `users.handle`/`users.email`;
 * `user.deleted` is the SOLE trigger for the erasure cascade
 * (`lib/repo/erasure.ts`) — no in-app route ever performs erasure directly.
 *
 * Fails closed: an unset signing secret rejects every request (503) rather
 * than accepting unsigned events, and a bad signature is a plain 400 before
 * the body is ever parsed as JSON.
 */

import { NextResponse } from "next/server";
import { Webhook } from "svix";
import { readAllBounded } from "@heimdall/shared";
import type { ApiError } from "@heimdall/shared";
import { getAuthEnv } from "@/lib/env";
import { syncUserFromClerkEvent } from "@/lib/repo/users";
import { enqueueUserErasureFromClerk } from "@/lib/repo/erasure";
import { jsonError } from "@/lib/api/http";

export const runtime = "nodejs";

interface ClerkEmailAddress {
  id: string;
  email_address: string;
}

interface ClerkUserEventData {
  id: string;
  username?: string | null;
  primary_email_address_id?: string | null;
  email_addresses?: ClerkEmailAddress[];
}

interface ClerkWebhookEvent {
  type: string;
  data: ClerkUserEventData;
}

// Clerk user events are small JSON documents. Keep a separate cap from ingest
// metadata so a legitimate profile event has room while an unauthenticated
// caller cannot allocate an unbounded raw body before Svix verification.
const MAX_WEBHOOK_BYTES = 256 * 1024;

function primaryEmail(data: ClerkUserEventData): string | null {
  const addresses = data.email_addresses ?? [];
  const primary = addresses.find((address) => address.id === data.primary_email_address_id);
  return primary?.email_address ?? addresses[0]?.email_address ?? null;
}

async function readWebhookPayload(request: Request): Promise<string | NextResponse<ApiError>> {
  const declaredLength = request.headers.get("content-length");
  if (declaredLength !== null) {
    const bytes = Number(declaredLength);
    if (Number.isFinite(bytes) && bytes > MAX_WEBHOOK_BYTES) {
      return jsonError(413, "payload-too-large", "webhook body exceeds the size limit");
    }
  }
  if (!request.body) return "";
  try {
    const bytes = await readAllBounded(request.body, MAX_WEBHOOK_BYTES);
    if (bytes === null) {
      return jsonError(413, "payload-too-large", "webhook body exceeds the size limit");
    }
    return new TextDecoder().decode(bytes);
  } catch {
    return jsonError(400, "invalid-payload", "webhook body could not be read");
  }
}

export async function POST(request: Request): Promise<NextResponse<ApiError | { received: true }>> {
  const { CLERK_WEBHOOK_SIGNING_SECRET } = getAuthEnv();
  if (!CLERK_WEBHOOK_SIGNING_SECRET) {
    return jsonError(503, "not-configured", "webhook signing secret is not configured");
  }

  const svixId = request.headers.get("svix-id");
  const svixTimestamp = request.headers.get("svix-timestamp");
  const svixSignature = request.headers.get("svix-signature");
  if (!svixId || !svixTimestamp || !svixSignature) {
    return jsonError(400, "invalid-signature", "missing svix headers");
  }

  const payload = await readWebhookPayload(request);
  if (payload instanceof NextResponse) {
    return payload;
  }
  let event: ClerkWebhookEvent;
  try {
    event = new Webhook(CLERK_WEBHOOK_SIGNING_SECRET).verify(payload, {
      "svix-id": svixId,
      "svix-timestamp": svixTimestamp,
      "svix-signature": svixSignature,
    }) as ClerkWebhookEvent;
  } catch {
    return jsonError(400, "invalid-signature", "webhook signature verification failed");
  }

  try {
    switch (event.type) {
      case "user.created":
      case "user.updated":
        await syncUserFromClerkEvent({
          svixId,
          type: event.type,
          userId: event.data.id,
          profile: {
            handle: event.data.username ?? null,
            email: primaryEmail(event.data),
          },
        });
        break;
      case "user.deleted":
        await enqueueUserErasureFromClerk(event.data.id, svixId);
        break;
      default:
        // Unhandled event types are a no-op — acknowledge so Svix stops retrying.
        break;
    }
  } catch (error) {
    console.error(`POST /api/webhooks/clerk failed (type=${event.type})`, error);
    return jsonError(500, "internal", "webhook processing failed");
  }

  return NextResponse.json({ received: true });
}
