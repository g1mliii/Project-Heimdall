/**
 * Shared route-handler plumbing (Phase 4): the uniform error envelope, zod
 * body parsing, client-ip extraction, and the rate-limit gate. Every /api
 * route builds on these — no bespoke error shapes.
 */

import { NextResponse } from "next/server";
import type { ZodType } from "zod";
import { INGEST_LIMITS, readAllBounded, type ApiError } from "@heimdall/shared";
import { getIngestEnv } from "../env";
import { consumeRateLimit } from "../repo/rate-limit";

/** Uniform failure envelope (`apiErrorSchema` in @heimdall/shared). */
export function jsonError(
  status: number,
  code: string,
  message: string,
  init?: { details?: unknown; retryAfterSeconds?: number },
): NextResponse<ApiError> {
  const headers = new Headers();
  if (init?.retryAfterSeconds !== undefined) {
    headers.set("Retry-After", String(init.retryAfterSeconds));
  }
  return NextResponse.json(
    { error: { code, message, ...(init?.details !== undefined ? { details: init.details } : {}) } },
    { status, headers },
  );
}

/**
 * Parse + validate a JSON body. Returns the typed value, or a ready-to-return
 * 400/413 response (discriminate with `instanceof NextResponse`). The body is
 * streamed with a byte cap so JSON metadata cannot allocate an unbounded heap
 * buffer before zod reaches its field limits.
 */
export async function parseJsonBody<T>(
  request: Request,
  schema: ZodType<T>,
  { maxBytes = INGEST_LIMITS.maxMetadataBytes }: { maxBytes?: number } = {},
): Promise<T | NextResponse<ApiError>> {
  const declaredLength = request.headers.get("content-length");
  if (declaredLength !== null) {
    const bytes = Number(declaredLength);
    if (Number.isFinite(bytes) && bytes > maxBytes) {
      return jsonError(413, "payload-too-large", `request body exceeds ${maxBytes} bytes`);
    }
  }

  let text: string;
  try {
    if (!request.body) {
      text = "";
    } else {
      const bytes = await readAllBounded(request.body, maxBytes);
      // `readAllBounded` returns null rather than throwing, so this stays a 413
      // instead of being caught below and reported as a malformed body.
      if (bytes === null) {
        return jsonError(413, "payload-too-large", `request body exceeds ${maxBytes} bytes`);
      }
      text = new TextDecoder().decode(bytes);
    }
  } catch {
    return jsonError(400, "invalid-json", "request body must be valid JSON");
  }

  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return jsonError(400, "invalid-json", "request body must be valid JSON");
  }
  const result = schema.safeParse(raw);
  if (!result.success) {
    return jsonError(400, "invalid-request", "request body failed validation", {
      details: result.error.issues.map((issue) => ({
        path: issue.path.join("."),
        message: issue.message,
      })),
    });
  }
  return result.data;
}

/** The token from an `Authorization: Bearer <token>` header; null when absent/empty. */
export function bearerToken(request: Request): string | null {
  const auth = request.headers.get("authorization");
  if (!auth?.startsWith("Bearer ")) {
    return null;
  }
  return auth.slice("Bearer ".length).trim() || null;
}

/**
 * Best-effort client ip for rate limiting. `x-forwarded-for` is spoofable
 * when the app is not behind a trusted proxy — acceptable for Phase 4 abuse
 * control (the deployment platform sets it in prod; a spoofer only ever
 * escapes the limit, never impersonates another bucket's quota into denial,
 * because buckets are per-ip strings, not identities).
 */
export function clientIp(request: Request): string {
  const forwarded = request.headers.get("x-forwarded-for");
  const first = forwarded?.split(",")[0]?.trim();
  return first || "local";
}

/**
 * Rate-limit gate: null when allowed, a ready 429 when not. Fails OPEN on DB
 * errors — a broken limiter must not take the ingest path down with it.
 */
export async function requireRateLimit(
  scope: string,
  request: Request,
  limitPerHour: number,
): Promise<NextResponse<ApiError> | null> {
  try {
    const result = await consumeRateLimit(scope, clientIp(request), limitPerHour, 3600);
    if (!result.allowed) {
      return jsonError(429, "rate-limited", "too many requests — slow down", {
        retryAfterSeconds: result.retryAfterSeconds,
      });
    }
    return null;
  } catch (error) {
    console.error(`rate limit check failed (scope=${scope}); failing open`, error);
    return null;
  }
}

/** The per-scope hourly limits, env-tunable (§11.10). */
export function rateLimits() {
  const env = getIngestEnv();
  return {
    createRuns: env.RATE_LIMIT_CREATE_RUNS_PER_HOUR,
    finalize: env.RATE_LIMIT_FINALIZE_PER_HOUR,
    delete: env.RATE_LIMIT_DELETE_PER_HOUR,
  };
}
