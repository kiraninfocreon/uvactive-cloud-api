# Break-Glass Procedure — Admin Account Recovery

Per spec §4.3: if a single `super_admin` account loses **both** their
password **and** their TOTP device, **with no backup codes remaining**,
none of the normal recovery paths work:

- `POST /auth/admin/forgot-password` gets them a new password, but they
  still can't pass the TOTP/backup-code check to log in.
- `POST /admin/admins/:id/reset-2fa` requires another **already-logged-in
  super_admin** to call it — if this is the *only* super_admin account,
  there's nobody who can.

This is deliberate: nothing in the API can bypass 2FA for the admin
realm, by design. Recovery in this specific case requires direct
database access by the infra team. **Document who is authorized to do
this and dry-run it at least once before any real gym goes live** (see
main README's testing checklist) — this is not something to improvise
during an actual incident.

## Who is authorized

_Fill in before launch:_ name the specific people (by role, e.g. "the
on-call infra lead and the CTO") who may perform this procedure, and
require **two of them** to be involved — one to run the commands, one
to confirm the request is legitimate and log it. Never a single person
acting alone.

## Procedure

1. **Verify the request out-of-band.** Confirm with the account holder
   through a channel other than email (phone call, in person) that they
   genuinely lost both factors — this procedure fully bypasses 2FA, so
   it's a high-value social-engineering target.
2. **Connect to production Postgres** as the `uvactive_migrator` role
   (never `uvactive_app` — it doesn't have the privileges this needs
   anyway, see `infra/db-grants.sql`).
3. **Look up the account:**
   ```sql
   SELECT id, name, email, role, totp_enabled FROM admins WHERE email = '<email>';
   ```
4. **Clear the 2FA state** so the account gets the normal
   `setupRequired` flow on next login (same effect as
   `POST /admin/admins/:id/reset-2fa`, run manually because no other
   super_admin exists to call it):
   ```sql
   BEGIN;
   UPDATE admins SET totp_secret = NULL, totp_enabled = false WHERE id = '<admin_id>';
   DELETE FROM admin_backup_codes WHERE admin_id = '<admin_id>';
   UPDATE refresh_tokens SET revoked_at = now() WHERE admin_id = '<admin_id>' AND revoked_at IS NULL;
   COMMIT;
   ```
5. **Set a temporary password** if they also lost their password (skip
   if `forgot-password` already handled it):
   ```sql
   -- Generate the hash out-of-band with:
   --   node -e "require('argon2').hash(process.argv[1],{type:2}).then(console.log)" '<temp-password>'
   UPDATE admins SET password_hash = '<argon2-hash-from-above>' WHERE id = '<admin_id>';
   ```
6. **Have the account holder log in immediately**, complete the
   `setupRequired` → `/auth/admin/2fa/setup` → `/auth/admin/2fa/confirm`
   flow with a device you can confirm is theirs, and change the
   temporary password.
7. **Log the incident** in `audit_log` manually (the API's own audit
   trail can't capture a DB-level action) — insert a row:
   ```sql
   INSERT INTO audit_log (id, actor_type, actor_id, action, target_type, target_id, payload, created_at)
   VALUES (gen_random_uuid(), 'system', '<infra person's name/id>', 'admin.break_glass_recovery',
           'admin', '<admin_id>', '{"reason": "lost password + TOTP device + no backup codes", "authorized_by": "<second person>"}', now());
   ```
8. **Post-incident**: rotate `JWT_ADMIN_SECRET` if there's any doubt the
   account compromise (rather than genuine device loss) is what
   happened — this invalidates every admin session platform-wide, so
   only do this if actually warranted.

## Dry run

Before the first real gym goes live, run this entire procedure once
against staging with a throwaway admin account, timed, with both
authorized people participating. Fix anything that's unclear or slow
*before* you need it under pressure.
