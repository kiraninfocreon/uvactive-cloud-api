import { ConflictException, Injectable, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AuditLogService } from '../audit-log/audit-log.service';
import { hashSecret, verifySecret } from '../common/utils/hash.util';
import { CreateAdminDto } from './admins.dto';

@Injectable()
export class AdminsService {
  constructor(private readonly prisma: PrismaService, private readonly auditLog: AuditLogService) {}

  /** Used by high-consequence flows (e.g. member anonymization) that require the acting admin to re-enter their own password. */
  async verifyOwnPassword(adminId: string, password: string): Promise<void> {
    const admin = await this.prisma.admin.findUnique({ where: { id: adminId } });
    if (!admin || !(await verifySecret(admin.passwordHash, password))) {
      throw new UnauthorizedException('Password confirmation failed.');
    }
  }

  // Only reachable by an existing super_admin (enforced in the
  // controller via @Auth('admin', ['super_admin'])) — there is no
  // public admin self-registration route anywhere in this API. The
  // very first admin account is created by the seed script at
  // deploy time, not through the API (see prisma/seed.ts).
  async create(dto: CreateAdminDto, actorId: string) {
    const existing = await this.prisma.admin.findUnique({ where: { email: dto.email } });
    if (existing) throw new ConflictException('An admin with this email already exists.');
    const passwordHash = await hashSecret(dto.password);
    const admin = await this.prisma.admin.create({
      data: { name: dto.name, email: dto.email, passwordHash, role: dto.role || 'support' },
    });
    await this.auditLog.record({ actorType: 'admin', actorId, action: 'admin.create', targetType: 'admin', targetId: admin.id, payload: { role: admin.role } });
    return this.publicShape(admin);
  }

  async list() {
    const rows = await this.prisma.admin.findMany({ orderBy: { createdAt: 'desc' } });
    return rows.map(this.publicShape);
  }

  /**
   * Resets another admin's 2FA when they're locked out (lost device,
   * no backup codes left) — spec §4.3. Clears the TOTP secret and all
   * unused backup codes so the target admin gets the full setupToken
   * flow again on their next login. Does NOT touch their password.
   * super_admin only, enforced in the controller.
   */
  async reset2fa(targetId: string, actorId: string) {
    const target = await this.prisma.admin.findUnique({ where: { id: targetId } });
    if (!target) throw new NotFoundException('Admin not found.');
    await this.prisma.$transaction([
      this.prisma.admin.update({ where: { id: targetId }, data: { totpSecret: null, totpEnabled: false } }),
      this.prisma.adminBackupCode.deleteMany({ where: { adminId: targetId } }),
      this.prisma.refreshToken.updateMany({ where: { adminId: targetId, revokedAt: null }, data: { revokedAt: new Date() } }),
    ]);
    await this.auditLog.record({ actorType: 'admin', actorId, action: 'admin.reset_2fa', targetType: 'admin', targetId, payload: { admin_override: true } });
    return { ok: true };
  }

  private publicShape(a: any) {
    const { passwordHash, totpSecret, ...rest } = a;
    return rest;
  }
}
