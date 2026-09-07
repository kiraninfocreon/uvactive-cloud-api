import { PrismaService } from '../../prisma/prisma.service';

/**
 * Result of one atomic increment against `rate_limit_counters`.
 * Mirrors what @nestjs/throttler's ThrottlerStorageRecord needs, plus
 * enough for RateLimitService's simpler count-only usage.
 */
export interface CounterResult {
  totalHits: number;
  windowRemainingMs: number;
  isBlocked: boolean;
  blockRemainingMs: number;
}

/**
 * Atomically increments the counter for `key`, resetting it if the
 * current window has lapsed, and sets a block window once `limit` is
 * exceeded — all in ONE statement.
 *
 * Why this is safe without an explicit transaction: `INSERT ... ON
 * CONFLICT (key) DO UPDATE` takes a row-level lock on the conflicting
 * row for the duration of the statement, so two replicas racing the
 * same key at the same instant are serialized by Postgres itself — the
 * second writer's CASE expressions see the first writer's committed
 * values, not a stale read. That's the same "no two callers can both
 * win" guarantee the previous Redis Lua script gave, just enforced by
 * Postgres's MVCC instead of Redis's single-threaded execution. This is
 * the ONE place that logic lives — both PgThrottlerStorage (general
 * per-route throttling) and RateLimitService (login-attempt limiting)
 * call this with different key prefixes and limits rather than each
 * re-implementing the increment logic.
 *
 * @param blockDurationMs pass 0 to disable blocking and just track a
 *   rolling count (what RateLimitService needs — it decides what to do
 *   with the count itself rather than being told "blocked").
 */
export async function pgIncrement(
  prisma: PrismaService,
  key: string,
  windowMs: number,
  limit: number,
  blockDurationMs: number,
): Promise<CounterResult> {
  const rows = await prisma.$queryRaw<
    { count: number; window_remaining_ms: number; is_blocked: boolean; block_remaining_ms: number }[]
  >`
    INSERT INTO "rate_limit_counters" AS rlc ("key", "count", "window_expires_at", "blocked_until", "updated_at")
    VALUES (${key}, 1, now() + (${windowMs} || ' milliseconds')::interval, NULL, now())
    ON CONFLICT ("key") DO UPDATE SET
      "count" = CASE
        WHEN rlc."blocked_until" IS NOT NULL AND rlc."blocked_until" > now() THEN rlc."count"
        WHEN rlc."window_expires_at" <= now() THEN 1
        ELSE rlc."count" + 1
      END,
      "window_expires_at" = CASE
        WHEN rlc."blocked_until" IS NOT NULL AND rlc."blocked_until" > now() THEN rlc."window_expires_at"
        WHEN rlc."window_expires_at" <= now() THEN now() + (${windowMs} || ' milliseconds')::interval
        ELSE rlc."window_expires_at"
      END,
      "blocked_until" = CASE
        WHEN rlc."blocked_until" IS NOT NULL AND rlc."blocked_until" > now() THEN rlc."blocked_until"
        WHEN ${blockDurationMs} > 0 AND (
          CASE WHEN rlc."window_expires_at" <= now() THEN 1 ELSE rlc."count" + 1 END
        ) > ${limit}
          THEN now() + (${blockDurationMs} || ' milliseconds')::interval
        ELSE NULL
      END,
      "updated_at" = now()
    RETURNING
      "count",
      GREATEST(0, EXTRACT(EPOCH FROM ("window_expires_at" - now())) * 1000)::float8 AS window_remaining_ms,
      ("blocked_until" IS NOT NULL AND "blocked_until" > now()) AS is_blocked,
      CASE WHEN "blocked_until" IS NOT NULL AND "blocked_until" > now()
        THEN GREATEST(0, EXTRACT(EPOCH FROM ("blocked_until" - now())) * 1000)::float8
        ELSE 0
      END AS block_remaining_ms
  `;
  const row = rows[0];
  return {
    totalHits: row.count,
    windowRemainingMs: Math.ceil(row.window_remaining_ms),
    isBlocked: row.is_blocked,
    blockRemainingMs: Math.ceil(row.block_remaining_ms),
  };
}

/** Reads the current count for `key` without incrementing it. */
export async function pgPeek(prisma: PrismaService, key: string): Promise<number> {
  const rows = await prisma.$queryRaw<{ count: number }[]>`
    SELECT "count" FROM "rate_limit_counters"
    WHERE "key" = ${key} AND "window_expires_at" > now()
  `;
  return rows[0]?.count ?? 0;
}

/** Deletes a key outright — used to clear a login limiter on success. */
export async function pgClear(prisma: PrismaService, key: string): Promise<void> {
  await prisma.$executeRaw`DELETE FROM "rate_limit_counters" WHERE "key" = ${key}`;
}
