-- Rich post-workout results per session member (UV score breakdown:
-- sweat/recovery points, EPOC, avg/max %MHR, final rank). All nullable
-- so existing rows and sessions ended before this migration stay valid.
ALTER TABLE "session_members"
  ADD COLUMN "sweat_points"    DOUBLE PRECISION,
  ADD COLUMN "recovery_points" DOUBLE PRECISION,
  ADD COLUMN "recovery_grade"  TEXT,
  ADD COLUMN "epoc_calories"   DOUBLE PRECISION,
  ADD COLUMN "epoc_hours"      DOUBLE PRECISION,
  ADD COLUMN "avg_pct_mhr"     DOUBLE PRECISION,
  ADD COLUMN "max_pct_mhr"     DOUBLE PRECISION,
  ADD COLUMN "final_rank"      INTEGER;
