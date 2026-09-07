import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../../prisma/prisma.service';

/**
 * Deletes rows from `rate_limit_counters` whose window AND block (if
 * any) have both lapsed — the Redis equivalent got this for free via
 * PEXPIRE; a plain Postgres table needs an explicit sweep so it doesn't
 * grow by one row per (identifier, IP) pair ever seen. Safe to run from
 * every replica concurrently — DELETE ... WHERE is idempotent, no
 * advisory lock needed (contrast with the migration lock, which guards
 * DDL, not row deletes).
 */
@Injectable()
export class RateLimitSweepJob {
  private readonly logger = new Logger(RateLimitSweepJob.name);

  constructor(private readonly prisma: PrismaService) {}

  @Cron(CronExpression.EVERY_HOUR)
  async handle() {
    const { count } = await this.prisma.rateLimitCounter.deleteMany({
      where: {
        windowExpiresAt: { lte: new Date() },
        OR: [{ blockedUntil: null }, { blockedUntil: { lte: new Date() } }],
      },
    });
    if (count > 0) this.logger.log(`Swept ${count} expired rate-limit counter row(s).`);
  }
}
