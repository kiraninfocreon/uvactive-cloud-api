-- Gym: front-desk phone + free-text area/city, distinct from the
-- existing street `address` and from ownerContact's contact blob.
ALTER TABLE "gyms" ADD COLUMN "location" TEXT;
ALTER TABLE "gyms" ADD COLUMN "gym_phone" TEXT;

-- Member: bio fields mandatory on both create forms (Admin Panel +
-- Branch Portal) going forward, nullable in the DB only because
-- pre-existing rows predate this.
CREATE TYPE "Sex" AS ENUM ('male', 'female', 'other');

ALTER TABLE "members" ADD COLUMN "sex" "Sex";
ALTER TABLE "members" ADD COLUMN "age_years" INTEGER;
ALTER TABLE "members" ADD COLUMN "height_cm" DOUBLE PRECISION;
ALTER TABLE "members" ADD COLUMN "weight_kg" DOUBLE PRECISION;
ALTER TABLE "members" ADD COLUMN "resting_hr" INTEGER;
