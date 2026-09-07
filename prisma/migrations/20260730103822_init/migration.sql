-- CreateEnum
CREATE TYPE "GymStatus" AS ENUM ('active', 'suspended', 'deleted');

-- CreateEnum
CREATE TYPE "MemberStatus" AS ENUM ('active', 'suspended', 'pending_transfer');

-- CreateEnum
CREATE TYPE "TrainerStatus" AS ENUM ('active', 'suspended');

-- CreateEnum
CREATE TYPE "StaffRole" AS ENUM ('trainer', 'branch_manager');

-- CreateEnum
CREATE TYPE "AdminRole" AS ENUM ('super_admin', 'support');

-- CreateEnum
CREATE TYPE "SessionStatus" AS ENUM ('scheduled', 'in_progress', 'completed', 'cancelled');

-- CreateEnum
CREATE TYPE "AttendanceStatus" AS ENUM ('enrolled', 'attended', 'no_show');

-- CreateEnum
CREATE TYPE "CancelledByType" AS ENUM ('trainer', 'branch', 'admin', 'system');

-- CreateEnum
CREATE TYPE "TransferStatus" AS ENUM ('pending', 'accepted', 'declined', 'expired');

-- CreateEnum
CREATE TYPE "ActorType" AS ENUM ('member', 'staff', 'admin', 'system');

-- CreateEnum
CREATE TYPE "NotificationChannel" AS ENUM ('push', 'sms', 'email');

-- CreateEnum
CREATE TYPE "NotificationStatus" AS ENUM ('pending', 'sent', 'failed');

-- CreateEnum
CREATE TYPE "AuthRealm" AS ENUM ('member', 'staff', 'admin');

-- CreateEnum
CREATE TYPE "ResetAccountType" AS ENUM ('staff', 'admin');

-- CreateTable
CREATE TABLE "gyms" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "address" TEXT,
    "owner_contact" TEXT,
    "logo_url" TEXT,
    "status" "GymStatus" NOT NULL DEFAULT 'active',
    "member_limit" INTEGER NOT NULL,
    "token_version" INTEGER NOT NULL DEFAULT 0,
    "created_by_admin_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "gyms_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "members" (
    "id" TEXT NOT NULL,
    "member_code" TEXT NOT NULL,
    "pin_hash" TEXT,
    "name" TEXT NOT NULL,
    "phone" TEXT,
    "email" TEXT,
    "dob" TIMESTAMP(3),
    "photo_url" TEXT,
    "status" "MemberStatus" NOT NULL DEFAULT 'active',
    "current_gym_id" TEXT,
    "failed_pin_attempts" INTEGER NOT NULL DEFAULT 0,
    "locked_until" TIMESTAMP(3),
    "is_anonymized" BOOLEAN NOT NULL DEFAULT false,
    "anonymized_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "members_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "member_gym_history" (
    "id" TEXT NOT NULL,
    "member_id" TEXT NOT NULL,
    "gym_id" TEXT NOT NULL,
    "joined_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "left_at" TIMESTAMP(3),
    "released_by_type" TEXT,
    "released_by_id" TEXT,
    "reason" TEXT,

    CONSTRAINT "member_gym_history_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "consents" (
    "id" TEXT NOT NULL,
    "member_id" TEXT NOT NULL,
    "version" TEXT NOT NULL,
    "accepted_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ip_address" TEXT,

    CONSTRAINT "consents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "trainers" (
    "id" TEXT NOT NULL,
    "gym_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "password_hash" TEXT NOT NULL,
    "phone" TEXT,
    "photo_url" TEXT,
    "role" "StaffRole" NOT NULL DEFAULT 'trainer',
    "status" "TrainerStatus" NOT NULL DEFAULT 'active',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "trainers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sessions" (
    "id" TEXT NOT NULL,
    "gym_id" TEXT NOT NULL,
    "trainer_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "capacity" INTEGER NOT NULL DEFAULT 30,
    "status" "SessionStatus" NOT NULL DEFAULT 'scheduled',
    "started_at" TIMESTAMP(3),
    "ended_at" TIMESTAMP(3),
    "scheduled_at" TIMESTAMP(3),
    "cancelled_reason" TEXT,
    "cancelled_by_type" "CancelledByType",
    "cancelled_by_id" TEXT,
    "needs_reassignment" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "session_members" (
    "id" TEXT NOT NULL,
    "session_id" TEXT NOT NULL,
    "member_id" TEXT NOT NULL,
    "enrolled_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "enrolled_by" TEXT NOT NULL,
    "attendance" "AttendanceStatus" NOT NULL DEFAULT 'enrolled',
    "avg_hr" INTEGER,
    "max_hr" INTEGER,
    "calories" DOUBLE PRECISION,
    "zone_minutes" JSONB,
    "score" DOUBLE PRECISION,
    "result_submitted_at" TIMESTAMP(3),
    "synced_at" TIMESTAMP(3),

    CONSTRAINT "session_members_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sensor_readings" (
    "id" TEXT NOT NULL,
    "session_member_id" TEXT NOT NULL,
    "ts" TIMESTAMP(3) NOT NULL,
    "hr" INTEGER NOT NULL,
    "rr_ms" INTEGER,

    CONSTRAINT "sensor_readings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "transfer_requests" (
    "id" TEXT NOT NULL,
    "member_id" TEXT NOT NULL,
    "from_gym_id" TEXT,
    "to_gym_id" TEXT NOT NULL,
    "requested_by_type" TEXT NOT NULL,
    "requested_by_id" TEXT,
    "status" "TransferStatus" NOT NULL DEFAULT 'pending',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "responded_at" TIMESTAMP(3),
    "expires_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "transfer_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "admins" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "password_hash" TEXT NOT NULL,
    "role" "AdminRole" NOT NULL DEFAULT 'support',
    "totp_secret" TEXT,
    "totp_enabled" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "admins_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "admin_backup_codes" (
    "id" TEXT NOT NULL,
    "admin_id" TEXT NOT NULL,
    "code_hash" TEXT NOT NULL,
    "used_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "admin_backup_codes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "password_reset_tokens" (
    "id" TEXT NOT NULL,
    "account_type" "ResetAccountType" NOT NULL,
    "account_id" TEXT NOT NULL,
    "token_hash" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "used_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "password_reset_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "member_pin_resets" (
    "id" TEXT NOT NULL,
    "member_id" TEXT NOT NULL,
    "otp_hash" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "used_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "member_pin_resets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "refresh_tokens" (
    "id" TEXT NOT NULL,
    "realm" "AuthRealm" NOT NULL,
    "token_hash" TEXT NOT NULL,
    "device_id" TEXT,
    "member_id" TEXT,
    "trainer_id" TEXT,
    "admin_id" TEXT,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "revoked_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "refresh_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_log" (
    "id" TEXT NOT NULL,
    "actor_type" "ActorType" NOT NULL,
    "actor_id" TEXT,
    "action" TEXT NOT NULL,
    "target_type" TEXT NOT NULL,
    "target_id" TEXT,
    "payload" JSONB,
    "ip" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_log_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notifications" (
    "id" TEXT NOT NULL,
    "recipient_type" TEXT NOT NULL,
    "recipient_id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "title" TEXT,
    "body" TEXT NOT NULL,
    "data" JSONB,
    "read_at" TIMESTAMP(3),
    "channel" "NotificationChannel",
    "recipient_address" TEXT,
    "status" "NotificationStatus" NOT NULL DEFAULT 'pending',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "last_error" TEXT,
    "sent_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notifications_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "members_member_code_key" ON "members"("member_code");

-- CreateIndex
CREATE INDEX "members_current_gym_id_idx" ON "members"("current_gym_id");

-- CreateIndex
CREATE INDEX "member_gym_history_member_id_idx" ON "member_gym_history"("member_id");

-- CreateIndex
CREATE INDEX "member_gym_history_gym_id_idx" ON "member_gym_history"("gym_id");

-- CreateIndex
CREATE INDEX "consents_member_id_idx" ON "consents"("member_id");

-- CreateIndex
CREATE UNIQUE INDEX "trainers_email_key" ON "trainers"("email");

-- CreateIndex
CREATE INDEX "trainers_gym_id_idx" ON "trainers"("gym_id");

-- CreateIndex
CREATE INDEX "sessions_gym_id_scheduled_at_idx" ON "sessions"("gym_id", "scheduled_at");

-- CreateIndex
CREATE INDEX "sessions_trainer_id_idx" ON "sessions"("trainer_id");

-- CreateIndex
CREATE INDEX "sessions_needs_reassignment_idx" ON "sessions"("needs_reassignment");

-- CreateIndex
CREATE UNIQUE INDEX "session_members_session_id_member_id_key" ON "session_members"("session_id", "member_id");

-- CreateIndex
CREATE INDEX "sensor_readings_session_member_id_ts_idx" ON "sensor_readings"("session_member_id", "ts");

-- CreateIndex
CREATE INDEX "transfer_requests_member_id_status_idx" ON "transfer_requests"("member_id", "status");

-- CreateIndex
CREATE INDEX "transfer_requests_to_gym_id_status_idx" ON "transfer_requests"("to_gym_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "admins_email_key" ON "admins"("email");

-- CreateIndex
CREATE INDEX "admin_backup_codes_admin_id_idx" ON "admin_backup_codes"("admin_id");

-- CreateIndex
CREATE UNIQUE INDEX "password_reset_tokens_token_hash_key" ON "password_reset_tokens"("token_hash");

-- CreateIndex
CREATE INDEX "member_pin_resets_member_id_idx" ON "member_pin_resets"("member_id");

-- CreateIndex
CREATE UNIQUE INDEX "refresh_tokens_token_hash_key" ON "refresh_tokens"("token_hash");

-- CreateIndex
CREATE INDEX "refresh_tokens_member_id_idx" ON "refresh_tokens"("member_id");

-- CreateIndex
CREATE INDEX "refresh_tokens_trainer_id_idx" ON "refresh_tokens"("trainer_id");

-- CreateIndex
CREATE INDEX "refresh_tokens_admin_id_idx" ON "refresh_tokens"("admin_id");

-- CreateIndex
CREATE INDEX "audit_log_target_type_target_id_idx" ON "audit_log"("target_type", "target_id");

-- CreateIndex
CREATE INDEX "audit_log_actor_type_actor_id_idx" ON "audit_log"("actor_type", "actor_id");

-- CreateIndex
CREATE INDEX "notifications_recipient_type_recipient_id_read_at_idx" ON "notifications"("recipient_type", "recipient_id", "read_at");

-- CreateIndex
CREATE INDEX "notifications_status_idx" ON "notifications"("status");

-- AddForeignKey
ALTER TABLE "members" ADD CONSTRAINT "members_current_gym_id_fkey" FOREIGN KEY ("current_gym_id") REFERENCES "gyms"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "member_gym_history" ADD CONSTRAINT "member_gym_history_member_id_fkey" FOREIGN KEY ("member_id") REFERENCES "members"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "member_gym_history" ADD CONSTRAINT "member_gym_history_gym_id_fkey" FOREIGN KEY ("gym_id") REFERENCES "gyms"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "consents" ADD CONSTRAINT "consents_member_id_fkey" FOREIGN KEY ("member_id") REFERENCES "members"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "trainers" ADD CONSTRAINT "trainers_gym_id_fkey" FOREIGN KEY ("gym_id") REFERENCES "gyms"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_gym_id_fkey" FOREIGN KEY ("gym_id") REFERENCES "gyms"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_trainer_id_fkey" FOREIGN KEY ("trainer_id") REFERENCES "trainers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "session_members" ADD CONSTRAINT "session_members_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "sessions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "session_members" ADD CONSTRAINT "session_members_member_id_fkey" FOREIGN KEY ("member_id") REFERENCES "members"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sensor_readings" ADD CONSTRAINT "sensor_readings_session_member_id_fkey" FOREIGN KEY ("session_member_id") REFERENCES "session_members"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transfer_requests" ADD CONSTRAINT "transfer_requests_member_id_fkey" FOREIGN KEY ("member_id") REFERENCES "members"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transfer_requests" ADD CONSTRAINT "transfer_requests_from_gym_id_fkey" FOREIGN KEY ("from_gym_id") REFERENCES "gyms"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transfer_requests" ADD CONSTRAINT "transfer_requests_to_gym_id_fkey" FOREIGN KEY ("to_gym_id") REFERENCES "gyms"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "admin_backup_codes" ADD CONSTRAINT "admin_backup_codes_admin_id_fkey" FOREIGN KEY ("admin_id") REFERENCES "admins"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "member_pin_resets" ADD CONSTRAINT "member_pin_resets_member_id_fkey" FOREIGN KEY ("member_id") REFERENCES "members"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "refresh_tokens" ADD CONSTRAINT "refresh_tokens_member_id_fkey" FOREIGN KEY ("member_id") REFERENCES "members"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "refresh_tokens" ADD CONSTRAINT "refresh_tokens_trainer_id_fkey" FOREIGN KEY ("trainer_id") REFERENCES "trainers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "refresh_tokens" ADD CONSTRAINT "refresh_tokens_admin_id_fkey" FOREIGN KEY ("admin_id") REFERENCES "admins"("id") ON DELETE SET NULL ON UPDATE CASCADE;
