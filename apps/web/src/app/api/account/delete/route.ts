/**
 * POST /api/account/delete (§20.4) — the caller deletes their own Clerk
 * account. This route does NOT run the erasure cascade itself — it only
 * asks Clerk to delete the user, which fires the `user.deleted` webhook
 * (`app/api/webhooks/clerk/route.ts`), the sole trigger for durable erasure
 * (§20.1i). Keeping one erasure path, driven by the webhook, means the
 * cascade can't drift from what actually happens to the account.
 */

import { NextResponse } from "next/server";
import { clerkClient } from "@clerk/nextjs/server";
import { requireViewer } from "@/lib/api/auth";
import { jsonError } from "@/lib/api/http";
import { getAuthEnv } from "@/lib/env";

export const runtime = "nodejs";

export async function POST(): Promise<NextResponse> {
  try {
    const viewer = await requireViewer();
    if (viewer instanceof NextResponse) {
      return viewer;
    }

    // Clerk's delete call only initiates erasure; the verified user.deleted
    // webhook is the sole durable cascade trigger. Refuse to delete the
    // account when this deployment cannot verify that webhook.
    if (!getAuthEnv().CLERK_WEBHOOK_SIGNING_SECRET) {
      return jsonError(503, "erasure-unavailable", "account deletion is temporarily unavailable");
    }

    const client = await clerkClient();
    await client.users.deleteUser(viewer.userId);

    return new NextResponse(null, { status: 202 });
  } catch (error) {
    console.error("POST /api/account/delete failed", error);
    return jsonError(500, "internal", "account deletion failed");
  }
}
