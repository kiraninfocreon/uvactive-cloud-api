import { applyDecorators, createParamDecorator, ExecutionContext, SetMetadata, UseGuards } from '@nestjs/common';
import { AuthGuard } from '../guards/auth.guard';
import { RolesGuard } from '../guards/roles.guard';
import { GymActiveGuard } from '../guards/gym-active.guard';

export const REALM_KEY = 'realm';
export const ROLES_KEY = 'roles';

export type Realm = 'member' | 'staff' | 'admin';

/**
 * Applies the full auth chain for a route: verifies the JWT against the
 * secret for `realm`, checks `roles` (if given) against the token's role
 * claim, and — for the staff realm only — re-checks the owning gym's
 * status + token_version on every single request (the suspension
 * cascade). Use this instead of stacking guards manually so no route
 * can accidentally skip the gym-status re-check.
 */
export function Auth(realm: Realm, roles?: string[]) {
  const guards = realm === 'staff' ? [AuthGuard, GymActiveGuard, RolesGuard] : [AuthGuard, RolesGuard];
  return applyDecorators(
    SetMetadata(REALM_KEY, realm),
    SetMetadata(ROLES_KEY, roles || []),
    UseGuards(...guards),
  );
}

export interface AuthenticatedUser {
  sub: string; // member.id / trainer.id / admin.id
  realm: Realm;
  role?: string; // staff: 'trainer' | 'branch_manager'; admin: 'super_admin' | 'support'
  gymId?: string; // staff only
  gymTokenVersion?: number; // staff only — checked against Gym.tokenVersion by GymActiveGuard
}

export const CurrentUser = createParamDecorator((_data: unknown, ctx: ExecutionContext): AuthenticatedUser => {
  const req = ctx.switchToHttp().getRequest();
  return req.user;
});
