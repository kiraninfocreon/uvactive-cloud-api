import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { TokenService } from '../utils/token.service';
import { REALM_KEY, Realm } from '../decorators/auth.decorator';

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(private readonly reflector: Reflector, private readonly tokens: TokenService) {}

  canActivate(ctx: ExecutionContext): boolean {
    const realm = this.reflector.getAllAndOverride<Realm>(REALM_KEY, [ctx.getHandler(), ctx.getClass()]);
    if (!realm) return true; // route has no @Auth() — public

    const req = ctx.switchToHttp().getRequest();
    const header = req.headers['authorization'] || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;
    if (!token) throw new UnauthorizedException('No token provided.');

    const payload = this.tokens.verifyAccessToken(token, realm);
    if (payload.realm !== realm) throw new UnauthorizedException('Token is not valid for this endpoint.');

    req.user = payload;
    return true;
  }
}
