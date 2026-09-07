-- Adds mandatory-2FA + optional-Google-link support to the staff realm
-- (mirrors the admins/admin_backup_codes shape), and marks which
-- trainer row is a gym's auto-created primary branch-manager account.

-- AlterTable
ALTER TABLE "trainers"
  ADD COLUMN "totp_secret" TEXT,
  ADD COLUMN "totp_enabled" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "google_id" TEXT,
  ADD COLUMN "is_primary_manager" BOOLEAN NOT NULL DEFAULT false;

-- CreateIndex
CREATE UNIQUE INDEX "trainers_google_id_key" ON "trainers"("google_id");

-- CreateTable
CREATE TABLE "staff_backup_codes" (
    "id" TEXT NOT NULL,
    "trainer_id" TEXT NOT NULL,
    "code_hash" TEXT NOT NULL,
    "used_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "staff_backup_codes_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "staff_backup_codes_trainer_id_idx" ON "staff_backup_codes"("trainer_id");

-- AddForeignKey
ALTER TABLE "staff_backup_codes" ADD CONSTRAINT "staff_backup_codes_trainer_id_fkey" FOREIGN KEY ("trainer_id") REFERENCES "trainers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AlterTable — Settings screen needs a separate contact-email field
-- alongside the existing owner_contact (used as the contact phone).
ALTER TABLE "gyms" ADD COLUMN "contact_email" TEXT;
