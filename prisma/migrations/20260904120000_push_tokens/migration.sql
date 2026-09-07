-- Expo push tokens for the Member App and Trainer App, so notify()
-- can reach a real device push, not just the in-app bell.
ALTER TABLE "members" ADD COLUMN "push_token" TEXT;
ALTER TABLE "trainers" ADD COLUMN "push_token" TEXT;
