CREATE TABLE "sensors" (
    "id" TEXT NOT NULL,
    "gym_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "sensor_id" TEXT NOT NULL,
    "note" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sensors_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "sensors_gym_id_idx" ON "sensors"("gym_id");
CREATE UNIQUE INDEX "sensors_gym_id_sensor_id_key" ON "sensors"("gym_id", "sensor_id");

ALTER TABLE "sensors" ADD CONSTRAINT "sensors_gym_id_fkey" FOREIGN KEY ("gym_id") REFERENCES "gyms"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
