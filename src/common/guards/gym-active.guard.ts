import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { AppException } from '../exceptions/app.exception';

/**
 * This is what makes the suspension-cascade promise in the product docs
 * actually true: a staff JWT carries the gym's token_version at the
 * moment of login, and EVERY authenticated staff request re-checks that
 * value (and gym.status, and the individual trainer's own status)
 * against the live row — not just at next login. Suspending a gym
 * therefore invalidates every trainer's session on their very next
 * request, not eventually when a 15-minute access token happens to
 * expire.
 *
 * Deliberately a separate guard from AuthGuard/RolesGuard (rather than
 * folded into one mega-guard) so it's easy to see, audit, and unit-test
 * in isolation — this is the single most safety-critical check in the
 * whole API.
 */
@Injectable()
export class GymActiveGuard implements CanActivate {
  constructor(private readonly prisma: PrismaService) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest();
    const user = req.user;
    if (!user || user.realm !== 'staff') return true; // not a staff-realm route

    const gym = await this.prisma.gym.findUnique({ where: { id: user.gymId } });
    if (!gym || gym.status !== 'active') {
      throw new AppException('GYM_SUSPENDED', 'Your branch has been suspended — contact UV Active support.', 401);
    }
    if (gym.tokenVersion !== user.gymTokenVersion) {
      throw new UnauthorizedException('Your session is out of date — please log in again.');
    }

    const trainer = await this.prisma.trainer.findUnique({ where: { id: user.sub } });
    if (!trainer || trainer.status !== 'active') {
      throw new UnauthorizedException('Your staff account has been suspended.');
    }

    return true;
  }
}
