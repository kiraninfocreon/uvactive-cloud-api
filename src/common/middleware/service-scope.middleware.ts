import { Request, Response, NextFunction } from 'express';
import { NotFoundException } from '@nestjs/common';
import { GLOBAL_PREFIX } from '../../config/global-prefix';

export type ServiceScope = 'admin' | 'branch' | 'public' | 'all';

// Path prefixes each scope is allowed to reach, checked against the
// request path (and, for a few rules, HTTP method) with the global
// API prefix stripped. Order doesn't matter — every candidate is
// checked independently.
//
//   admin  → Admin Panel's own backend fork only:  /admin/*,  /auth/admin/*
//   branch → Branch Portal's own backend fork only: /branch/*, /auth/staff/*
//   public → THIS service (Trainer app + Member app): /trainer/*, /member/*,
//            /auth/staff/*, /auth/member/*, plus three GET-only reads into
//            /branch/* the Trainer App genuinely needs (see below)
//
// This service (uvactive-cloud-api) only ever runs as 'public' now —
// the admin/branch allowlists below stay here so the three forks
// (this one, uvactive-admin-panel/backend, uvactive-branch-portal/backend)
// don't drift apart on what each scope means, even though this
// deployment never uses the admin/branch branches itself.
//
// Branch Portal and the Trainer app both authenticate branch staff via
// the same /auth/staff/* endpoints (a branch manager logs into the
// portal, a trainer logs into the app) — that's why staff auth is
// listed under both 'branch' and 'public'.
//
// The Trainer App also reads three branch-owned resources directly —
// its own source says so: "Members (roster, read-only from the
// Trainer App)" and "Sensors (read-only inventory — management stays
// on the Branch Portal)" (src/services/sessionsApi.ts). It calls:
//   GET /branch/members            (roster list, for session setup)
//   GET /branch/members/search     (add-by-code during session setup)
//   GET /branch/members/:id/profile
//   GET /branch/sensors            (BLE sensor inventory)
//   GET /branch/dashboard          (home screen summary)
// These are allowed through on 'public' as GET-only — the other
// verbs on those same paths (POST /branch/members to register a new
// member, PATCH/POST for release, reset-pin, sensor CRUD, etc.) stay
// branch-only. Role guards inside those controllers would reject a
// plain trainer token from most of those writes anyway, but keeping
// them unreachable here too means a trainer-scoped credential can't
// even attempt them against this deployment — one less thing for the
// role guards to be the only thing standing between a bug and a
// cross-realm write.
type ScopeRule = string | { prefix: string; methods: string[] };

const SCOPE_ALLOWLIST: Record<Exclude<ServiceScope, 'all'>, ScopeRule[]> = {
  admin: ['/admin/', '/auth/admin/'],
  branch: ['/branch/', '/auth/staff/'],
  public: [
    '/trainer/',
    '/member/',
    '/auth/staff/',
    '/auth/member/',
    { prefix: '/branch/members', methods: ['GET'] },
    { prefix: '/branch/sensors', methods: ['GET'] },
    { prefix: '/branch/dashboard', methods: ['GET'] },
  ],
};

// Always reachable regardless of scope — health checks (uptime
// monitors/Render's own probe hit this un-authenticated) and the two
// auth endpoints genuinely shared by every realm's token lifecycle.
const ALWAYS_ALLOWED = ['/health', '/auth/refresh', '/auth/logout'];

export function createServiceScopeMiddleware(scope: ServiceScope) {
  return function serviceScopeGate(req: Request, _res: Response, next: NextFunction) {
    if (scope === 'all') return next(); // single-process / local dev — every route live, nothing to gate

    const prefix = `/${GLOBAL_PREFIX}`;
    const path = req.path.startsWith(prefix) ? req.path.slice(prefix.length) : req.path;

    if (ALWAYS_ALLOWED.some((p) => path === p || path.startsWith(p))) return next();

    const allowed = SCOPE_ALLOWLIST[scope].some((rule) =>
      typeof rule === 'string'
        ? path.startsWith(rule)
        : path.startsWith(rule.prefix) && rule.methods.includes(req.method),
    );
    if (allowed) return next();

    // A 404, not a 403 — a deployment that doesn't serve /admin/* at
    // all shouldn't confirm the route exists somewhere else. Same
    // NotFoundException the rest of the app throws, so it comes back
    // through the normal exception filter with the normal envelope
    // shape instead of a raw Express 404 page.
    throw new NotFoundException('Not found.');
  };
}
