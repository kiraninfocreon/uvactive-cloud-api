-- Interval/target-zone consistency % (spec's Post-Workout Summary Data
-- Output Specification) was computed by the Trainer App's
-- finalizeSummary() but had no column to land in. Nullable/additive,
-- same shape as the 20260813100000_session_member_rich_results
-- migration — existing rows and sessions ended before this migration
-- stay valid with a null value.
ALTER TABLE "session_members"
  ADD COLUMN "consistency_pct" DOUBLE PRECISION;
