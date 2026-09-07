-- Least-privilege DB role setup for the UV Active Cloud API.
--
-- Run this ONCE against a fresh database, as a superuser/owner role,
-- AFTER `prisma migrate deploy` has created the schema (the roles
-- below don't own any tables, so they can't create/alter them).
--
-- Re-run the GRANT/REVOKE block (everything below the CREATE ROLE
-- statements) after every `prisma migrate deploy` that adds a new
-- table — Prisma migrations don't know about these roles and won't
-- carry the grants forward automatically. Two roles:
--
--   uvactive_migrator — owns the schema, used ONLY by CI/CD's
--                        `prisma migrate deploy` step. Never used by
--                        the running API.
--   uvactive_app       — the role the running API connects as
--                        (DATABASE_URL in production). Full CRUD on
--                        every table EXCEPT audit_log, where it can
--                        only INSERT + SELECT — so even a compromised
--                        app-layer bug can never rewrite history.

-- ── Roles (skip if they already exist) ──────────────────────────────
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'uvactive_migrator') THEN
    CREATE ROLE uvactive_migrator LOGIN PASSWORD 'CHANGE_ME_MIGRATOR';
  END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'uvactive_app') THEN
    CREATE ROLE uvactive_app LOGIN PASSWORD 'CHANGE_ME_APP';
  END IF;
END $$;

GRANT ALL PRIVILEGES ON SCHEMA public TO uvactive_migrator;
GRANT USAGE ON SCHEMA public TO uvactive_app;

-- ── App role: full CRUD on every table except audit_log ─────────────
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO uvactive_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO uvactive_app;

-- The one deliberate exception — append-only, no exceptions, not even
-- for the app's own service account.
REVOKE UPDATE, DELETE ON audit_log FROM uvactive_app;
GRANT SELECT, INSERT ON audit_log TO uvactive_app;

-- Keep future tables covered automatically for new migrations created
-- by uvactive_migrator (doesn't retroactively apply to existing
-- tables — re-run the block above after each migrate deploy).
ALTER DEFAULT PRIVILEGES FOR ROLE uvactive_migrator IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO uvactive_app;
ALTER DEFAULT PRIVILEGES FOR ROLE uvactive_migrator IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO uvactive_app;

-- Verification query — run after applying, confirm audit_log shows
-- only {SELECT, INSERT} for uvactive_app:
--   SELECT grantee, table_name, privilege_type
--   FROM information_schema.role_table_grants
--   WHERE grantee = 'uvactive_app' AND table_name = 'audit_log';
