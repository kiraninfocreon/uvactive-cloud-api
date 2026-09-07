import { Injectable, HttpException, HttpStatus } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { pgIncrement, pgPeek, pgClear } from './pg-rate-limit.util';

const WINDOW_MS = 15 * 60 * 1000; // 15 minutes
const MAX_ATTEMPTS = 5;
const KEY_PREFIX = 'login:';

/**
 * Same policy as the original cloud-api's rateLimit.js (5 attempts / 15
 * min, keyed on both the identifier AND the source IP so an attacker
 * can't dodge one by rotating the other) — backed by the shared
 * `rate_limit_counters` Postgres table (see pg-rate-limit.util.ts) so
 * the limit holds across every replica, not just the process that
 * happened to handle a given request. No Redis, no separate managed
 * service to provision or fail over — this rides on the same Postgres
 * connection every replica already has open for Prisma.
 */
@Injectable()
export class RateLimitService {
  constructor(private readonly prisma: PrismaService) {}

  /** Throws 429 if either key is over budget. Call BEFORE attempting the login check. */
  async assertNotBlocked(keys: string[]): Promise<void> {
    for (const key of keys) {
      const count = await pgPeek(this.prisma, KEY_PREFIX + key);
      if (count >= MAX_ATTEMPTS) {
        throw new HttpException('Too many failed attempts. Try again in 15 minutes.', HttpStatus.TOO_MANY_REQUESTS);
      }
    }
  }

  async recordFailure(key: string): Promise<void> {
    // blockDurationMs=0: this service decides what to do with the count
    // itself (assertNotBlocked), it doesn't need pg-rate-limit.util's
    // own blocked_until to also fire.
    await pgIncrement(this.prisma, KEY_PREFIX + key, WINDOW_MS, MAX_ATTEMPTS, 0);
  }

  async clear(key: string): Promise<void> {
    await pgClear(this.prisma, KEY_PREFIX + key);
  }
}
