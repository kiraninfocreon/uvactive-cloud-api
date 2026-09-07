ALTER TABLE "members" ADD COLUMN "password_hash" TEXT;

-- Email becomes the member's web-login identity (alongside the
-- existing memberCode+PIN kiosk/QR path), so it needs to be unique.
-- NOTE: if this deploy already has members sharing a duplicate email
-- (or multiple blank strings — NULL is fine and unlimited, but ''
-- is not), dedupe/null those out before running this migration or it
-- will fail on the unique index below.
CREATE UNIQUE INDEX "members_email_key" ON "members"("email");
