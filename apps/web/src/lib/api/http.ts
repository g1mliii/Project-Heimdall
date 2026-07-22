/**
 * Shared route-handler plumbing (Phase 4): the uniform error envelope, zod
 * body parsing, client-ip extraction, and the rate-limit gate. Every /api
 * route builds on these — no bespoke error shapes.
 */

import { NextResponse } from "next/server";
import { isIP } from "node:net";
import type { ZodError, ZodType } from "zod";
import { INGEST_LIMITS, readAllBounded, type ApiError } from "@heimdall/shared";
import { getAuthEnv, getIngestEnv } from "../env";
import { consumeRateLimit } from "../repo/rate-limit";
import type { ViewerIdentity } from "../viewer";

function validationDetails(error: ZodError) {
  return error.issues.map((issue) => ({
    path: issue.path.join("."),
    message: issue.message,
  }));
}

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
      details: validationDetails(result.error),
    });
  }
  return result.data;
}

/**
 * Parse + validate URL query parameters with the same ready-to-return 400
 * contract as {@link parseJsonBody}. Repeated keys become arrays instead of
 * silently choosing a winner, so scalar schemas reject ambiguous requests.
 */
export function parseQuery<T>(
  request: Request,
  schema: ZodType<T>,
): T | NextResponse<ApiError> {
  const raw: Record<string, string | string[]> = {};
  for (const [key, value] of new URL(request.url).searchParams) {
    const existing = raw[key];
    if (existing === undefined) {
      raw[key] = value;
    } else if (Array.isArray(existing)) {
      existing.push(value);
    } else {
      raw[key] = [existing, value];
    }
  }

  const result = schema.safeParse(raw);
  if (!result.success) {
    return jsonError(400, "invalid-request", "request query failed validation", {
      details: validationDetails(result.error),
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
 * Client IP for rate limiting. Forwarded headers are attacker-controlled at a
 * directly reachable origin, so an operator must opt into exactly one after
 * locking the origin behind that trusted proxy. Until then every anonymous
 * caller shares the conservative `unknown` bucket instead of receiving a
 * forgeable bypass.
 */
export function clientIp(request: Request): string {
  const trust = getIngestEnv().RATE_LIMIT_TRUSTED_PROXY;
  const raw =
    trust === "cloudflare"
      ? request.headers.get("cf-connecting-ip")
      : trust === "x-forwarded-for"
        ? request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null
        : null;
  return raw && isIP(raw) !== 0 ? raw : "unknown";
}

/**
 * Rate-limit gate: null when allowed, a ready 429 when not. It fails closed
 * when the limiter is unavailable: serving an unbounded upload/report path
 * during a database outage turns the outage into a storage or moderation DoS.
 *
 * Keys `user:{id}` when signed in, else `ip:{ip}` (§20.2f) — a stable
 * identity outlasts IP churn, and it's a materially higher bar to farm many
 * accounts than to rotate IPs. Signed-in requests get `limitPerHour` scaled
 * by `RATE_LIMIT_AUTHED_MULTIPLIER` (default 3x) instead of a second env var
 * per scope.
 *
 * Takes a `ViewerIdentity`, not a `Viewer`: only `userId` is read, so a
 * caller that needs nothing else can use `getViewerIdentity()` and skip the
 * `users` round trip entirely. A full `Viewer` still satisfies this.
 */
export async function requireRateLimit(
  scope: string,
  request: Request,
  limitPerHour: number,
  viewer?: ViewerIdentity | null,
): Promise<NextResponse<ApiError> | null> {
  const clientKey = viewer ? `user:${viewer.userId}` : `ip:${clientIp(request)}`;
  const limit = viewer
    ? Math.round(limitPerHour * getAuthEnv().RATE_LIMIT_AUTHED_MULTIPLIER)
    : limitPerHour;
  try {
    const result = await consumeRateLimit(scope, clientKey, limit, 3600);
    if (!result.allowed) {
      return jsonError(429, "rate-limited", "too many requests — slow down", {
        retryAfterSeconds: result.retryAfterSeconds,
      });
    }
    return null;
  } catch (error) {
    console.error(`rate limit check failed (scope=${scope}); denying request`, error);
    return jsonError(503, "rate-limit-unavailable", "rate limit is temporarily unavailable", {
      retryAfterSeconds: 60,
    });
  }
}

/** The per-scope hourly limits, env-tunable (§11.10). */
export function rateLimits() {
  const env = getIngestEnv();
  return {
    createRuns: env.RATE_LIMIT_CREATE_RUNS_PER_HOUR,
    finalize: env.RATE_LIMIT_FINALIZE_PER_HOUR,
    delete: env.RATE_LIMIT_DELETE_PER_HOUR,
    search: env.RATE_LIMIT_SEARCH_PER_HOUR,
    claim: env.RATE_LIMIT_CLAIM_PER_HOUR,
    createReport: env.RATE_LIMIT_CREATE_REPORT_PER_HOUR,
  };
}
