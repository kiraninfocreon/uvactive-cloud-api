-- Adds a nullable job-claim lease column to notifications, for safe
-- multi-instance cron dedup if this backend is ever scaled beyond the
-- single DO instance it launches on. Not read/written by any code path
-- yet (see the field comment in schema.prisma) — purely additive,
-- zero-downtime, no backfill needed.
ALTER TABLE "notifications" ADD COLUMN "claimed_at" TIMESTAMP(3);
