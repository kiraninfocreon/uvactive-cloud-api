import { Injectable } from '@nestjs/common';
import { ThrottlerStorage } from '@nestjs/throttler';
import type { ThrottlerStorageRecord } from '@nestjs/throttler/dist/throttler-storage-record.interface';
import { PrismaService } from '../../prisma/prisma.service';
import { pgIncrement } from './pg-rate-limit.util';

/**
 * The default @nestjs/throttler storage keeps its hit counters in a
 * plain JS Map inside the process. That's fine for one instance, but
 * this API is meant to run as multiple horizontally-scaled replicas
 * behind a load balancer (see Dockerfile / infra/do-app-platform.yaml)
 * — with in-memory storage, each replica enforces the limit
 * independently, so N replicas effectively allow N x the configured
 * rate through in aggregate.
 *
 * This backs the same guarantee with the shared `rate_limit_counters`
 * Postgres table instead of Redis (see pg-rate-limit.util.ts for the
 * atomic increment this delegates to) — one less moving part to
 * provision, monitor and pay for, since every replica already holds a
 * Postgres connection for Prisma.
 */
@Injectable()
export class PgThrottlerStorage implements ThrottlerStorage {
  constructor(private readonly prisma: PrismaService) {}

  async increment(
    key: string,
    ttl: number,
    limit: number,
    blockDuration: number,
    throttlerName: string,
  ): Promise<ThrottlerStorageRecord> {
    const result = await pgIncrement(this.prisma, `throttle:${throttlerName}:${key}`, ttl, limit, blockDuration);
    return {
      totalHits: result.totalHits,
      timeToExpire: Math.ceil(result.windowRemainingMs / 1000),
      isBlocked: result.isBlocked,
      timeToBlockExpire: Math.ceil(result.blockRemainingMs / 1000),
    };
  }
}
