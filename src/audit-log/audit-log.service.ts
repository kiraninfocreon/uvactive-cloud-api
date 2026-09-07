import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { ActorType } from '@prisma/client';

export interface AuditEntry {
  actorType: ActorType;
  actorId?: string;
  action: string;
  targetType: string;
  targetId?: string;
  payload?: Record<string, unknown>;
  ip?: string;
}

/**
 * Every mutating action platform-wide gets written here — not just
 * Admin-initiated ones (Cloud API spec §3.9). Called explicitly from
 * each service right after its own mutation succeeds, rather than via a
 * generic interceptor, so the before/after diff that actually matters
 * (e.g. "released from gym X, reason Y") is meaningful instead of a raw
 * request/response dump.
 *
 * DB-level grants restricting this table to INSERT+SELECT for the app's
 * runtime role (no UPDATE/DELETE) are configured in infra — see
 * README's "Least-privilege DB role" section — so even a compromised
 * app-layer bug can't rewrite history.
 */
@Injectable()
export class AuditLogService {
  constructor(private readonly prisma: PrismaService) {}

  async record(entry: AuditEntry): Promise<void> {
    await this.prisma.auditLog.create({
      data: {
        actorType: entry.actorType,
        actorId: entry.actorId,
        action: entry.action,
        targetType: entry.targetType,
        targetId: entry.targetId,
        payload: entry.payload as any,
        ip: entry.ip,
      },
    });
  }

  async list(params: { targetType?: string; actorId?: string; take?: number; skip?: number }) {
    const { targetType, actorId, take = 50, skip = 0 } = params;
    const where = { ...(targetType ? { targetType } : {}), ...(actorId ? { actorId } : {}) };
    const [data, total] = await Promise.all([
      this.prisma.auditLog.findMany({ where, orderBy: { createdAt: 'desc' }, take, skip }),
      this.prisma.auditLog.count({ where }),
    ]);
    return { data, meta: { skip, take, total } };
  }
}
