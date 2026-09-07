import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ThrottlerStorage } from '@nestjs/throttler';
import type { ThrottlerStorageRecord } from '@nestjs/throttler/dist/throttler-storage-record.interface';
import Redis from 'ioredis';

/**
 * The default @nestjs/throttler storage keeps its hit counters in a plain
 * JS Map inside the process. That's fine for one instance, but this API
 * is meant to run as multiple horizontally-scaled replicas behind a load
 * balancer (see Dockerfile / docker-compose.yml) — with in-memory
 * storage, each replica enforces the 120 req/min limit independently, so
 * N replicas effectively allow N x 120 req/min through in aggregate. Not
 * a data-corruption bug like the notification-retry race was, but it
 * silently defeats the point of a shared rate limit once you actually
 * scale out. This mirrors RateLimitService's existing convention
 * (Redis when REDIS_URL is set, in-memory fallback with a warned-about
 * degradation when it isn't) so login throttling and general request
 * throttling behave consistently.
 *
 * The increment is done as a single Lua script so the check-and-block
 * logic stays atomic even with concurrent requests hitting the same key
 * across different replicas at the same instant — two replicas racing on
 * the same key can't both "win" and let a request through that should
 * have been blocked.
 */
const INCREMENT_SCRIPT = `
local hitsKey = KEYS[1]
local blockKey = KEYS[2]
local ttlMs = tonumber(ARGV[1])
local limit = tonumber(ARGV[2])
local blockDurationMs = tonumber(ARGV[3])

local blockPttl = redis.call('PTTL', blockKey)
if blockPttl > 0 then
  return {limit + 1, 0, 1, blockPttl}
end

local hits = redis.call('INCR', hitsKey)
if hits == 1 then
  redis.call('PEXPIRE', hitsKey, ttlMs)
end
local pttl = redis.call('PTTL', hitsKey)
if pttl < 0 then
  redis.call('PEXPIRE', hitsKey, ttlMs)
  pttl = ttlMs
end

local isBlocked = 0
local newBlockPttl = 0
if hits > limit then
  isBlocked = 1
  newBlockPttl = blockDurationMs > 0 and blockDurationMs or ttlMs
  redis.call('SET', blockKey, '1', 'PX', newBlockPttl)
end

return {hits, pttl, isBlocked, newBlockPttl}
`;

@Injectable()
export class RedisThrottlerStorage implements ThrottlerStorage, OnModuleDestroy {
  private readonly logger = new Logger(RedisThrottlerStorage.name);
  private redis: Redis | null = null;
  // Fallback path only — correct for a single instance, and this is the
  // same degradation RateLimitService already accepts when REDIS_URL is
  // unset, not a new gap.
  private memory = new Map<string, { count: number; expiresAt: number; blockedUntil: number }>();

  constructor(config: ConfigService) {
    const url = config.get<string>('redisUrl');
    if (url) {
      this.redis = new Redis(url, { maxRetriesPerRequest: 2 });
      this.redis.on('error', (e) => this.logger.warn(`Redis error, request throttling may degrade: ${e.message}`));
    } else {
      this.logger.warn('REDIS_URL not set — request throttling is in-memory/per-process only (fine for a single instance, not enforced globally once you scale out).');
    }
  }

  async onModuleDestroy() {
    if (this.redis) await this.redis.quit();
  }

  async increment(
    key: string,
    ttl: number,
    limit: number,
    blockDuration: number,
    throttlerName: string,
  ): Promise<ThrottlerStorageRecord> {
    const hitsKey = `throttle:${throttlerName}:${key}`;
    const blockKey = `throttle:${throttlerName}:${key}:blocked`;

    if (this.redis) {
      const [totalHits, pttl, isBlocked, blockPttl] = (await this.redis.eval(
        INCREMENT_SCRIPT,
        2,
        hitsKey,
        blockKey,
        ttl,
        limit,
        blockDuration,
      )) as [number, number, number, number];
      return {
        totalHits,
        timeToExpire: Math.ceil(pttl / 1000),
        isBlocked: isBlocked === 1,
        timeToBlockExpire: Math.ceil(blockPttl / 1000),
      };
    }

    // In-memory fallback — single instance only, mirrors the same
    // check-increment-block sequence as the Redis path above.
    const now = Date.now();
    let entry = this.memory.get(hitsKey);
    if (entry && entry.blockedUntil > now) {
      return { totalHits: limit + 1, timeToExpire: 0, isBlocked: true, timeToBlockExpire: Math.ceil((entry.blockedUntil - now) / 1000) };
    }
    if (!entry || entry.expiresAt <= now) {
      entry = { count: 0, expiresAt: now + ttl, blockedUntil: 0 };
      this.memory.set(hitsKey, entry);
    }
    entry.count += 1;
    const isBlocked = entry.count > limit;
    if (isBlocked) entry.blockedUntil = now + (blockDuration > 0 ? blockDuration : ttl);
    return {
      totalHits: entry.count,
      timeToExpire: Math.ceil((entry.expiresAt - now) / 1000),
      isBlocked,
      timeToBlockExpire: isBlocked ? Math.ceil((entry.blockedUntil - now) / 1000) : 0,
    };
  }
}
