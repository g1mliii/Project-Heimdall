/**
 * Typed, validated server environment (Phase 2).
 *
 * Split per concern (DB vs R2) and parsed lazily on first use so a code path —
 * or a test — that only touches Postgres never demands R2 credentials. A missing
 * var still fails fast at the first real use, with every missing name listed.
 * Server-only: never import from a client component.
 */

import { z } from "zod";

const dbEnvSchema = z.object({
  /** Pooled Neon connection string — see .env.example. */
  DATABASE_URL: z.string().min(1),
  /** Per-process cap; every serverless/dev process owns its own pool. */
  DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(20).default(5),
  /** Server-side guardrail for accidental table scans or stuck locks. */
  DATABASE_STATEMENT_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(60_000).default(15_000),
  /** Client-side guardrail so route handlers do not hang forever. */
  DATABASE_QUERY_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(60_000).default(20_000),
});

const r2EnvSchema = z.object({
  R2_ACCOUNT_ID: z.string().min(1),
  R2_ACCESS_KEY_ID: z.string().min(1),
  R2_SECRET_ACCESS_KEY: z.string().min(1),
  R2_BUCKET: z.string().min(1),
});

const ingestEnvSchema = z.object({
  /**
   * Bearer token guarding POST /api/internal/jobs/drain. Optional so dev and
   * DB-only tests boot without it, but the drain route itself 401s when the
   * token is unset — an unguarded drain endpoint is worse than none.
   */
  INTERNAL_JOBS_TOKEN: z
    .string()
    .min(24)
    .optional()
    // Treat blank (the .env.example default) as absent, like the signing key.
    .or(z.literal("").transform(() => undefined)),
  /** Base64 SPKI Ed25519 public key (§11.7); absent → signature_valid stays null. */
  HEIMDALL_SIGNING_PUBLIC_KEY: z
    .string()
    .regex(/^[A-Za-z0-9+/=]+$/, "must be base64")
    .optional()
    // Treat blank (the .env.example default) as absent.
    .or(z.literal("").transform(() => undefined)),
  /** Per-IP fixed-window limits, requests per hour (§11.10). */
  RATE_LIMIT_CREATE_RUNS_PER_HOUR: z.coerce.number().int().min(1).default(30),
  RATE_LIMIT_FINALIZE_PER_HOUR: z.coerce.number().int().min(1).default(60),
  RATE_LIMIT_DELETE_PER_HOUR: z.coerce.number().int().min(1).default(20),
  /** Catalog typeahead is read-only but intentionally chatty. */
  RATE_LIMIT_SEARCH_PER_HOUR: z.coerce.number().int().min(1).default(600),
});

function parseEnv<T extends z.ZodRawShape>(schema: z.ZodObject<T>, label: string) {
  const result = schema.safeParse(process.env);
  if (!result.success) {
    const missing = result.error.issues.map((issue) => issue.path.join(".")).join(", ");
    throw new Error(`Missing/invalid ${label} environment variables: ${missing} — see .env.example.`);
  }
  return result.data;
}

let dbEnvCache: z.infer<typeof dbEnvSchema> | undefined;
let r2EnvCache: z.infer<typeof r2EnvSchema> | undefined;
let ingestEnvCache: z.infer<typeof ingestEnvSchema> | undefined;

export function getDbEnv(): z.infer<typeof dbEnvSchema> {
  dbEnvCache ??= parseEnv(dbEnvSchema, "Postgres");
  return dbEnvCache;
}

export function getR2Env(): z.infer<typeof r2EnvSchema> {
  r2EnvCache ??= parseEnv(r2EnvSchema, "R2");
  return r2EnvCache;
}

export function getIngestEnv(): z.infer<typeof ingestEnvSchema> {
  ingestEnvCache ??= parseEnv(ingestEnvSchema, "ingest");
  return ingestEnvCache;
}
