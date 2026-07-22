/**
 * PATCH /api/account (§20.1b/§20.2) — edit the caller's own handle. Email
 * stays Clerk-managed (synced by the webhook, never editable here).
 */

import { NextResponse } from "next/server";
import { updateAccountRequestSchema } from "@heimdall/shared";
import type { AccountResponse } from "@heimdall/shared";
import { isUniqueViolation } from "@/lib/db";
import { isValidHandle, updateUserHandle } from "@/lib/repo/users";
import { requireViewer } from "@/lib/api/auth";
import { jsonError, parseJsonBody } from "@/lib/api/http";

export const runtime = "nodejs";

export async function PATCH(request: Request): Promise<NextResponse> {
  try {
    const viewer = await requireViewer();
    if (viewer instanceof NextResponse) {
      return viewer;
    }

    const body = await parseJsonBody(request, updateAccountRequestSchema);
    if (body instanceof NextResponse) {
      return body;
    }

    if (!isValidHandle(body.handle)) {
      return jsonError(
        400,
        "invalid-handle",
        "handle must be 3-32 lowercase letters, digits, or hyphens, starting alphanumeric, and not reserved",
      );
    }

    let updated;
    try {
      updated = await updateUserHandle(viewer.userId, body.handle);
    } catch (error) {
      if (isUniqueViolation(error, "users_handle_key")) {
        return jsonError(409, "handle-taken", "that handle is already in use");
      }
      throw error;
    }
    if (!updated) {
      return jsonError(404, "not-found", "account not found");
    }
    const response: AccountResponse = updated;
    return NextResponse.json(response);
  } catch (error) {
    console.error("PATCH /api/account failed", error);
    return jsonError(500, "internal", "account update failed");
  }
}
