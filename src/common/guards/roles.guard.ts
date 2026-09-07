import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ROLES_KEY } from '../decorators/auth.decorator';

@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(ctx: ExecutionContext): boolean {
    const roles = this.reflector.getAllAndOverride<string[]>(ROLES_KEY, [ctx.getHandler(), ctx.getClass()]);
    if (!roles || roles.length === 0) return true; // no role restriction beyond realm

    const req = ctx.switchToHttp().getRequest();
    const userRole = req.user?.role;
    if (!userRole || !roles.includes(userRole)) {
      throw new ForbiddenException(`This action requires one of: ${roles.join(', ')}.`);
    }
    return true;
  }
}
