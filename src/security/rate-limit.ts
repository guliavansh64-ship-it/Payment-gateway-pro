/**
 * Database-backed fixed-window limiter for security-sensitive actions
 * (login, step-up, refunds). In-process counters do not survive multiple
 * instances, so critical limits are persisted.
 */
import { one, query } from '../db/pool';

export type LimitResult = { allowed: boolean; retryAfterSeconds: number; remaining: number };

export async function consumeLimit(
  bucket: string,
  key: string,
  limit: number,
  windowSeconds: number,
): Promise<LimitResult> {
  const row = await one<{ count: number; window_start: string }>(
    `INSERT INTO rate_limits (bucket, key, window_start, count)
     VALUES ($1, $2, now(), 1)
     ON CONFLICT (bucket, key) DO UPDATE
       SET count = CASE WHEN rate_limits.window_start < now() - ($3 || ' seconds')::interval
                        THEN 1 ELSE rate_limits.count + 1 END,
           window_start = CASE WHEN rate_limits.window_start < now() - ($3 || ' seconds')::interval
                        THEN now() ELSE rate_limits.window_start END
     RETURNING count, window_start`,
    [bucket, key, windowSeconds],
  );
  const count = row?.count ?? 1;
  const elapsed = row ? (Date.now() - new Date(row.window_start).getTime()) / 1000 : 0;
  const retryAfter = Math.max(1, Math.ceil(windowSeconds - elapsed));
  return {
    allowed: count <= limit,
    retryAfterSeconds: retryAfter,
    remaining: Math.max(0, limit - count),
  };
}

export async function resetLimit(bucket: string, key: string): Promise<void> {
  await query('DELETE FROM rate_limits WHERE bucket = $1 AND key = $2', [bucket, key]);
}
