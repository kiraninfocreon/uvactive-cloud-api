import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as jwt from 'jsonwebtoken';
import { randomBytes, createHash } from 'crypto';
import { Realm } from '../decorators/auth.decorator';

export interface AccessTokenPayload {
  sub: string;
  realm: Realm;
  role?: string;
  gymId?: string;
  gymTokenVersion?: number;
}

/**
 * Three signing keys, one per realm — a leaked member secret must never
 * let anyone forge a staff or admin token. All three share the same
 * verify/sign mechanics, so this is one service parameterized by realm
 * rather than three near-duplicate ones.
 */
@Injectable()
export class TokenService {
  constructor(private readonly config: ConfigService) {}

  private secretFor(realm: Realm): string {
    const map: Record<Realm, string> = {
      member: this.config.get('jwt.memberSecret')!,
      staff: this.config.get('jwt.staffSecret')!,
      admin: this.config.get('jwt.adminSecret')!,
    };
    return map[realm];
  }

  private ttlMinutesFor(realm: Realm): number {
    const map: Record<Realm, number> = {
      member: this.config.get('jwt.accessTtlMinMember')!,
      staff: this.config.get('jwt.accessTtlMinStaff')!,
      admin: this.config.get('jwt.accessTtlMinAdmin')!,
    };
    return map[realm];
  }

  signAccessToken(payload: AccessTokenPayload): string {
    const ttlMin = this.ttlMinutesFor(payload.realm);
    return jwt.sign(payload, this.secretFor(payload.realm), { expiresIn: `${ttlMin}m` });
  }

  verifyAccessToken(token: string, realm: Realm): AccessTokenPayload {
    try {
      return jwt.verify(token, this.secretFor(realm)) as unknown as AccessTokenPayload;
    } catch {
      throw new UnauthorizedException('Invalid or expired session — please log in again.');
    }
  }

  /**
   * Refresh tokens are opaque random strings, NOT JWTs — they're stored
   * hashed in the refresh_tokens table (device-scoped) so logout / a
   * PIN or password reset can revoke exactly one device's session
   * rather than nothing. Returns {token, hash, expiresAt}.
   */
  generateRefreshToken(ttlDays: number): { token: string; hash: string; expiresAt: Date } {
    const token = randomBytes(48).toString('base64url');
    const hash = createHash('sha256').update(token).digest('hex');
    const expiresAt = new Date(Date.now() + ttlDays * 24 * 3600 * 1000);
    return { token, hash, expiresAt };
  }

  hashRefreshToken(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }
}
