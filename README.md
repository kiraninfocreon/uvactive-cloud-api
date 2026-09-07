# UV Active Cloud API

The sole system of record for gyms, members, trainers, sessions, and
transfers. Trainer App, Member App, Branch Web Portal, and Admin Panel
are all thin clients around this service — every business rule
(suspension cascade, capacity-safe booking, PIN generation, history
retention, consent-vs-override, anonymization) is enforced **here**,
never trusted to a client.

Replaces the old `cloud-api/` mirror entirely. No hub, no per-gym local
SQLite fallback — this is the only source of truth.

**Stated assumption, flag if wrong:** the retain-forever vs.
data-erasure conflict is resolved as anonymize-on-request, never
hard-delete (see §"Anonymization" below). This is the engineering
default until legal counsel confirms a different requirement.

## Stack

- **NestJS + TypeScript**
- **PostgreSQL** via **Prisma** (schema + migrations) — also backs
  cross-instance rate limiting (no Redis dependency; see
  `src/common/utils/pg-rate-limit.util.ts`)
- **argon2id** for PIN/password hashing
- **jsonwebtoken** — three separate signing secrets, one per auth realm
- **otplib** — TOTP for mandatory admin 2FA, plus 10 single-use backup codes
- **@nestjs/schedule** — cron jobs for notification retry, transfer-request expiry, and overdue-reassignment auto-cancel
- **Jest + Supertest** — real-database e2e tests for the concurrency-critical paths

## Local setup

```bash
cp .env.example .env
# fill in DATABASE_URL and generate the three JWT secrets:
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"

docker compose up -d          # local Postgres
npm install
npm run prisma:migrate:dev    # creates the schema
npm run seed                  # creates the first super_admin (interactive prompt)
npm run start:dev
```

API docs (Swagger, non-production only): `http://localhost:8080/api/docs`
Health check: `GET /api/v1/health` → `{status, db}`, 200 or 503.

## Global response envelope

Every response follows one of two shapes (spec §14):
```json
// success
{ "success": true, "data": {...}, "meta": { "skip": 0, "take": 50, "total": 123 } }
// error
{ "success": false, "error": { "code": "SESSION_FULL", "message": "..." }, "path": "/api/v1/..." }
```
Clients match on `error.code`, never on message text. Spec-named codes
(`GYM_SUSPENDED`, `MEMBER_LIMIT_REACHED`, `PIN_LOCKED`, `SESSION_FULL`,
`TRANSFER_ALREADY_RESPONDED`) are thrown explicitly via `AppException`;
every other error falls back to a generic code derived from the HTTP
status (`NOT_FOUND`, `FORBIDDEN`, `CONFLICT`, etc.) so no response is
ever left without a matchable code. `meta` is only populated on the
paginated admin list endpoints (`/admin/members`, `/admin/sessions`,
`/admin/audit-log`) — other list endpoints return a bare array in `data`.
`/health` is deliberately excluded from this envelope — it's consumed
raw by the load balancer and uptime monitor.

## Auth realms

| Realm  | Login | Recovery |
|---|---|---|
| Member | `POST /auth/member/login` `{memberCode, pin}` — lockout after 5 fails / 15 min, keyed to memberCode not device | `POST /auth/member/pin/reset-request` `{memberCode}` → OTP to phone/email, then `POST /auth/member/pin/reset-confirm` `{memberCode, otp, newPin}`. If the member can't receive the OTP at all, recovery falls back to branch-triggered `POST /branch/members/:id/reset-pin`. |
| Staff  | `POST /auth/staff/login` `{email, password}` | `POST /auth/staff/forgot-password` `{email}` → 15-min single-use link, `POST /auth/staff/reset-password` `{token, newPassword}` |
| Admin  | `POST /auth/admin/login` `{email, password, totp}` or `{..., backupCode}` — TOTP mandatory | `POST /auth/admin/forgot-password`/`reset-password` (password only); `POST /auth/admin/2fa/setup` (returns secret + 10 backup codes, shown once) → `POST /auth/admin/2fa/confirm`; `POST /admin/admins/:id/reset-2fa` (super_admin resets a locked-out peer's 2FA); if a lone super_admin loses password + device + all backup codes, see `infra/BREAK_GLASS_RUNBOOK.md` — this is the one case nothing in the API can fix. |

All three: `POST /auth/refresh {realm, refreshToken}`, `POST /auth/logout {realm, refreshToken}`.
Refresh tokens are opaque, device-scoped, stored hashed — logout revokes exactly one device's session.

### The suspension cascade, concretely

`Gym.tokenVersion` is bumped on every suspend/reactivate. A staff access
token carries the version that was current at login. **Every**
authenticated staff request re-checks `gym.status === 'active'` and
`gym.tokenVersion === token.gymTokenVersion` in `GymActiveGuard` — so
suspending a gym invalidates every trainer's session on their *next
request*, not whenever their 15-minute token happens to expire. Covered
by `test/suspension-cascade.e2e-spec.ts`.

## Endpoint map

```
POST   /auth/member/login | staff/login | admin/login
POST   /auth/member/pin/reset-request | reset-confirm
POST   /auth/staff/forgot-password | reset-password
POST   /auth/admin/forgot-password | reset-password
POST   /auth/admin/2fa/setup | 2fa/confirm
POST   /auth/refresh | logout

# Admin realm — global oversight, doesn't schedule day-to-day
GET    /admin/gyms            POST /admin/gyms           PATCH /admin/gyms/:id
POST   /admin/gyms/:id/suspend | activate    DELETE /admin/gyms/:id  (soft delete, blocked while members assigned)
GET    /admin/members         GET  /admin/members/search?code=
GET    /admin/members/:id     POST /admin/members/:id/assign   (override, admin_override:true)
POST   /admin/members/:id/release | reset-pin
POST   /admin/members/:id/anonymize  {adminPassword}   (super_admin only, one-way)
GET    /admin/trainers        POST /admin/trainers/:id/suspend | activate
GET    /admin/sessions        GET  /admin/sessions/:id
POST   /admin/transfer-requests   (consent-preserving alternative to direct override)
GET    /admin/audit-log
GET    /admin/notifications   POST /admin/notifications/:id/read
POST   /admin/admins  (super_admin only)   GET /admin/admins   POST /admin/admins/:id/reset-2fa

# Staff realm — branch_manager (registration, roster, trainers) + trainer (sessions)
POST   /branch/members  {..., consentVersion, consentAccepted}   GET /branch/members   GET /branch/members/search?code=
PATCH  /branch/members/:id    POST /branch/members/:id/release | reset-pin
POST   /branch/trainers       GET  /branch/trainers      PATCH /branch/trainers/:id
POST   /branch/trainers/:id/suspend | activate
POST   /branch/transfer-requests     GET /branch/transfer-requests
GET    /branch/sessions?needsReassignment=true     POST /branch/sessions/:id/members   DELETE .../members/:memberId
POST   /branch/sessions/:id/cancel   POST /branch/sessions/:id/reassign/:trainerId
GET    /branch/notifications  POST /branch/notifications/:id/read

POST   /trainer/sessions      GET  /trainer/sessions     GET /trainer/sessions/:id
POST   /trainer/sessions/:id/members     DELETE .../members/:memberId
POST   /trainer/sessions/:id/attendance  {memberId, attendance}
POST   /trainer/sessions/:id/start | end | cancel   (end is idempotent — safe to retry)
POST   /trainer/sessions/:id/readings    (optional raw BPM stream, additive only)

# Member realm
GET    /member/me             POST /member/change-pin
GET    /member/sessions       POST /member/sessions/:id/book       DELETE /member/sessions/:id/booking  (self-cancel, scheduled only)
GET    /member/transfer-requests
POST   /member/transfer-requests/:id/accept | decline
GET    /member/notifications  POST /member/notifications/:id/read
```

All routes are prefixed with `/api/v1` (see `main.ts`).

## Consent capture

`POST /branch/members` requires `consentVersion` (string) and
`consentAccepted` (boolean) — the registering staff member confirms the
member has been informed of and consents to data processing, logged
with a version + timestamp in the same transaction as the member row
(not a decorative checkbox — HR/biometric data is being collected).

## Anonymization (resolves retain-vs-erasure)

`POST /admin/members/:id/anonymize`, super_admin only, requires the
acting admin to re-enter their own password. Overwrites name/phone/
email/photo, clears the PIN (login disabled — effective account
closure), retains `member_code` and all `member_gym_history`/
`session_members` rows so other members' data and the gym's own
records stay intact. Distinct `audit_log` action
(`member.anonymize`) from a normal profile edit. **Confirm with legal
counsel this meets your actual regulatory obligation (India's DPDP
Act and/or GDPR if you expand) before launch** — this is the
engineering default, not a legal opinion.

## Session capacity engine — the concurrency-critical core

One shared function, `SessionsService.enrollMember()`, called
identically from branch/trainer/member routes. Implementation: a `SELECT
... FOR UPDATE` row lock on the parent `sessions` row inside the
transaction, THEN the count check, THEN the insert — this is what
actually prevents two *different* members from both winning the last
open seat under concurrent load. `UNIQUE(session_id, member_id)` is the
second line of defense, catching the same-member-twice case. Covered by
`test/capacity-race.e2e-spec.ts` (5 concurrent enrollments at capacity=1,
exactly one must win).

Cancellation: member self-cancel (`DELETE /member/sessions/:id/booking`,
only while `scheduled`), branch/trainer cancel-with-reason (notifies
every enrolled member), idempotent `POST .../end` (upsert keyed on
`(session_id, member_id)`, rejects results for anyone never enrolled or
a session never started).

## Trainer-suspension → session-reassignment cascade

Suspending a trainer (branch or admin-initiated) flags every one of
their still-`scheduled`, still-future sessions `needsReassignment=true`
and notifies the branch (`type: 'reassignment_needed'`) — surfaced via
`GET /branch/sessions?needsReassignment=true`, not a silent background
flag. Branch resolves it with `POST /branch/sessions/:id/reassign/:trainerId`
or an explicit cancel. A 10-minute cron (`SessionsReassignmentJob`)
auto-cancels anything still flagged past its own start time as the
fallback path, not the primary one. Covered by
`test/lifecycle-guards.e2e-spec.ts`.

## Testing

```bash
docker compose up -d   # test DB — point DATABASE_URL at a disposable database, never production
npm run test:e2e
```

Real integration tests against a real Postgres instance — deliberately,
because the row-lock and suspension-cascade behaviors are exactly the
kind of thing a mocked PrismaService would rubber-stamp without
exercising the actual transaction semantics. Covers the §17 checklist's
concurrency-sensitive items: capacity race, suspension mid-request,
idempotent session-end retry, gym-delete-blocked-while-assigned,
trainer-suspension reassignment flagging. **Not yet covered by
tests**: full backup-restore drill (must be a manual drill against your
actual managed Postgres instance, see below), booking-engine load test
at realistic peak, break-glass runbook dry-run.

## Deploying (DigitalOcean App Platform + Managed Postgres — see `infra/do-app-platform.yaml`)

**Why not Vercel:** Vercel's platform is built around serverless
functions and static frontends. This API doesn't fit that shape — it
runs `@nestjs/schedule` cron jobs (notification retry, transfer
expiry, rate-limit sweep) that need a long-lived process, holds a
persistent Prisma connection pool rather than opening one per request,
and coordinates database migrations across replicas with a Postgres
session-level advisory lock (`scripts/migrate-deploy-locked.cjs`) —
none of which a stateless, per-request function host supports well.
Vercel's project-creation API also validates `framework` against a
fixed preset list; forcing a NestJS API into a Next.js-shaped preset
(or one of its Prisma Postgres / Redis storage marketplace add-ons,
which assume that same serverless model) fights the framework rather
than deploying it. This repo instead ships a `Dockerfile` and
`infra/do-app-platform.yaml` for exactly this reason — deploy it there
(or any other container host: Fly.io, Render, a bare Droplet + your
own load balancer) instead of importing it into Vercel.

1. **Provision Postgres.** DigitalOcean Managed PG (or Neon) — the
   `do-app-platform.yaml` spec provisions this for you as
   `uvactive-db`. Enable automated backups + point-in-time recovery
   before go-live. This is the *only* datastore the API needs — no
   separate Redis/cache instance, and no need for Vercel's "Prisma
   Postgres" storage product either: `DATABASE_URL` just points at
   your own managed Postgres, set as a normal platform env var.
2. **Least-privilege DB roles.** Run `infra/db-grants.sql` once, as a
   superuser, after your first `prisma migrate deploy` — it creates
   `uvactive_migrator` (schema owner, CI/CD only) and `uvactive_app`
   (the role the running API connects as), and revokes UPDATE/DELETE on
   `audit_log` from `uvactive_app` specifically, so even a compromised
   app-layer bug can't rewrite history. **Re-run it after every
   migration that adds a table** — Prisma doesn't carry these grants
   forward on its own.
3. **Container host.** `doctl apps create --spec infra/do-app-platform.yaml`
   deploys the Dockerfile to DigitalOcean App Platform behind a load
   balancer. Stateless — scaling out to more gyms/members is just
   raising `instance_count`, nothing else to provision (rate limiting
   rides on the same Postgres, see the Stack section above).
4. **Env vars** — everything in `.env.example`, set as platform env vars,
   never committed. Three JWT secrets must be distinct.
5. **CI/CD** — GitHub Actions: on merge to `main`, run `prisma migrate
   deploy` + `test:e2e` against staging, build the Docker image, deploy
   staging, manual promote to production.
6. **First super_admin** — `npm run seed` once, pointed at production
   `DATABASE_URL`, from a trusted operator's machine or a one-off CI job
   — never expose a "create first admin" HTTP route.
7. **Break-glass procedure** — read and staff `infra/BREAK_GLASS_RUNBOOK.md`
   *before* go-live, and dry-run it once against staging.
8. **Observability** — Sentry, structured JSON logs, uptime monitoring
   on `/api/v1/health` independent from the two web portals' own checks.

## What's deliberately NOT here yet (Phase 2+)

- **Realtime layer** (Socket.IO — live transfer-request push, optional
  live-session HR broadcast) — build as a separate `services/realtime`
  process. REST stays the source of truth; realtime is display-only.
- **BullMQ-backed notification/job queue** — the current
  `NotificationsService` writes-then-attempts-immediately with cron
  retries, which needs no queue/broker infrastructure at all. Swap in
  a real BullMQ worker (Postgres-backed, e.g. `pg-boss`, to avoid
  reintroducing Redis) once volume justifies it.
- Read replica for admin analytics, billing hooks, CRM webhooks,
  GraphQL layer — explicitly not worth doing speculatively per the spec.
- Full backup-restore drill and realistic booking-engine load test —
  both need to happen against your actual managed Postgres instance,
  not this repo's test suite.
