-- Replaces Redis-backed rate limiting with a Postgres-backed shared
-- counter table. See schema.prisma's RateLimitCounter comment and
-- src/common/utils/pg-throttler-storage.ts for how this stays atomic
-- and correct across multiple replicas without Redis.
CREATE TABLE "rate_limit_counters" (
    "key" TEXT NOT NULL,
    "count" INTEGER NOT NULL DEFAULT 0,
    "window_expires_at" TIMESTAMP(3) NOT NULL,
    "blocked_until" TIMESTAMP(3),
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "rate_limit_counters_pkey" PRIMARY KEY ("key")
);

CREATE INDEX "rate_limit_counters_window_expires_at_idx" ON "rate_limit_counters"("window_expires_at");
