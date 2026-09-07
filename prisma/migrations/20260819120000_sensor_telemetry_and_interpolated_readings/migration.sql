-- Connectivity dashboard support:
--   1) sensor_readings.interpolated — marks rows synthesized by the
--      Trainer App's gap-fill watchdog (>15s dropout) rather than read
--      off the sensor. Defaults false so every existing row is
--      correctly "real data" with no backfill needed.
--   2) sensor_telemetry — live/last-known battery + connection state
--      per physical sensor, independent of any one session. Powers the
--      pre-session connectivity dashboard and portal "sensor health"
--      views. One row per sensor per gym, upserted on every connection
--      state change (not every tick).

ALTER TABLE "sensor_readings"
  ADD COLUMN "interpolated" BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE "sensor_telemetry" (
  "sensor_id"        TEXT NOT NULL,
  "gym_id"           TEXT NOT NULL,
  "battery_pct"      INTEGER,
  "last_seen_at"     TIMESTAMP(3) NOT NULL,
  "connection_state" TEXT NOT NULL DEFAULT 'disconnected',
  "last_session_id"  TEXT,
  "updated_at"       TIMESTAMP(3) NOT NULL,

  CONSTRAINT "sensor_telemetry_pkey" PRIMARY KEY ("sensor_id")
);

CREATE INDEX "sensor_telemetry_gym_id_idx" ON "sensor_telemetry"("gym_id");

ALTER TABLE "sensor_telemetry"
  ADD CONSTRAINT "sensor_telemetry_gym_id_fkey"
  FOREIGN KEY ("gym_id") REFERENCES "gyms"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
