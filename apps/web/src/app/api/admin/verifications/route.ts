/**
 * POST/DELETE /api/admin/verifications (§20.3) — grant/revoke the
 * verified-reviewer tier. Admin-only. `verifications` is the audit record;
 * `users.role` is the query-time source of truth — both are written
 * atomically by `lib/repo/verifications.ts`, and grant/revoke are no-ops
 * against an existing admin (see that module's docstring for why).
 */

import { NextResponse } from "next/server";
import {
  grantVerificationRequestSchema,
  revokeVerificationRequestSchema,
} from "@heimdall/shared";
import type { AccountResponse } from "@heimdall/shared";
import { grantVerification, revokeVerification } from "@/lib/repo/verifications";
import { requireAdmin } from "@/lib/api/auth";
import { jsonError, parseJsonBody } from "@/lib/api/http";

export const runtime = "nodejs";

export async function POST(request: Request): Promise<NextResponse> {
  try {
    const admin = await requireAdmin();
    if (admin instanceof NextResponse) {
      return admin;
    }

    const body = await parseJsonBody(request, grantVerificationRequestSchema);
    if (body instanceof NextResponse) {
      return body;
    }

    const updated = await grantVerification(body.userId, admin.userId, body.hardwareVetted);
    if (!updated) {
      return jsonError(404, "not-found", "user not found");
    }
    const response: AccountResponse = updated;
    return NextResponse.json(response);
  } catch (error) {
    console.error("POST /api/admin/verifications failed", error);
    return jsonError(500, "internal", "verification grant failed");
  }
}

export async function DELETE(request: Request): Promise<NextResponse> {
  try {
    const admin = await requireAdmin();
    if (admin instanceof NextResponse) {
      return admin;
    }

    const body = await parseJsonBody(request, revokeVerificationRequestSchema);
    if (body instanceof NextResponse) {
      return body;
    }

    const updated = await revokeVerification(body.userId);
    if (!updated) {
      return jsonError(404, "not-found", "user not found");
    }
    const response: AccountResponse = updated;
    return NextResponse.json(response);
  } catch (error) {
    console.error("DELETE /api/admin/verifications failed", error);
    return jsonError(500, "internal", "verification revoke failed");
  }
}
