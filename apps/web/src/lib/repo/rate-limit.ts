/**
 * DB-backed fixed-window rate limiting (§11.10).
 *
 * One upsert per checked request against the `rate_limits` table (0007). Fixed
 * windows are deliberately simple: the worst case admits 2× the limit across a
 * window boundary, which is fine for abuse control (the limits are generous;
 * the point is stopping storage-DoS loops, not precision shaping).
 */

import { query, getPool, type Queryable } from "../db";

export interface RateLimitResult {
  allowed: boolean;
  /** Seconds until the current window rolls (the Retry-After header value). */
  retryAfterSeconds: number;
}

export async function consumeRateLimit(
  scope: string,
  clientKey: string,
  limit: number,
  windowSeconds: number,
  db: Queryable = getPool(),
): Promise<RateLimitResult> {
  const rows = await query<{ count: number; retry_after: number }>(
    `insert into rate_limits (bucket, window_start, count)
     values ($1, to_timestamp(floor(extract(epoch from now()) / $2) * $2), 1)
     on conflict (bucket, window_start)
       do update set count = rate_limits.count + 1
     returning count,
               ceil(extract(epoch from (window_start + make_interval(secs => $2) - now())))::int
                 as retry_after`,
    [`${scope}:${clientKey}`, windowSeconds],
    db,
  );
  const row = rows[0];
  if (!row) {
    throw new Error("rate limit upsert returned no row");
  }
  return {
    allowed: row.count <= limit,
    retryAfterSeconds: Math.max(1, row.retry_after),
  };
}

/**
 * Housekeeping: windows older than a day are dead weight (§11.11 pass).
 * Bound each pass so a long outage never turns the next cron invocation into
 * one large, lock-heavy delete transaction.
 */
export async function pruneRateLimits(
  db: Queryable = getPool(),
  { limit = 1_000 }: { limit?: number } = {},
): Promise<number> {
  if (!Number.isInteger(limit) || limit < 1) {
    throw new RangeError("rate-limit prune limit must be a positive integer");
  }
  const result = await db.query(
    `with expired as (
       select ctid
         from rate_limits
        where window_start < now() - interval '1 day'
        order by window_start
        for update skip locked
        limit $1
     )
     delete from rate_limits rl
      using expired
      where rl.ctid = expired.ctid`,
    [limit],
  );
  return result.rowCount ?? 0;
}
