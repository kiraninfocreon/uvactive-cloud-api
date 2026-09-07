-- Downsampled BPM graph data, computed once at session-end from the
-- raw sensor_readings log instead of re-aggregating it on every graph
-- view. See chart-downsample.util.ts and sessions.service.ts.
ALTER TABLE "session_members" ADD COLUMN "chart_series" JSONB;
