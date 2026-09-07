import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AuditLogService } from '../audit-log/audit-log.service';
import { NotificationsService } from '../notifications/notifications.service';
import { hashSecret } from '../common/utils/hash.util';
import { generateTempPassword } from '../common/utils/id-generator';
import { CreateGymDto, ResetGymManagerPasswordDto, UpdateGymDto, UpdateGymManagerDto, UpdateGymProfileDto } from './gyms.dto';

@Injectable()
export class GymsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditLog: AuditLogService,
    private readonly notifications: NotificationsService,
  ) {}

  /**
   * Creates the Gym AND its primary branch-manager staff account in one
   * transaction — a gym with no login account is not a usable gym. Fixes
   * the original bug where GymsController POST /admin/gyms only ever
   * inserted a `gyms` row and left the branch with nothing to sign in
   * with. The manager's temporary password is generated server-side,
   * returned in plaintext exactly once in this response (and emailed),
   * and never stored or logged anywhere but as an argon2 hash from this
   * point on.
   */
  async create(dto: CreateGymDto, adminId: string) {
    const existingManager = await this.prisma.trainer.findUnique({ where: { email: dto.managerEmail } });
    if (existingManager) {
      throw new ConflictException('A staff account with this email already exists — use a different manager email.');
    }

    const temporaryPassword = generateTempPassword();
    const passwordHash = await hashSecret(temporaryPassword);

    const { gym, manager } = await this.prisma.$transaction(async (tx) => {
      const gym = await tx.gym.create({
        data: {
          name: dto.name,
          address: dto.address,
          location: dto.location,
          gymPhone: dto.gymPhone,
          ownerContact: dto.ownerContact,
          contactEmail: dto.contactEmail,
          memberLimit: dto.memberLimit,
          createdByAdminId: adminId,
        },
      });
      const manager = await tx.trainer.create({
        data: {
          gymId: gym.id,
          name: dto.managerName,
          email: dto.managerEmail,
          phone: dto.managerPhone,
          passwordHash,
          role: 'branch_manager',
          isPrimaryManager: true,
        },
      });
      return { gym, manager };
    });

    await this.auditLog.record({
      actorType: 'admin', actorId: adminId, action: 'gym.create', targetType: 'gym', targetId: gym.id,
      payload: { name: dto.name, memberLimit: dto.memberLimit, managerEmail: dto.managerEmail },
    });
    await this.auditLog.record({
      actorType: 'admin', actorId: adminId, action: 'trainer.create', targetType: 'trainer', targetId: manager.id,
      payload: { gymId: gym.id, role: 'branch_manager', auto_created_with_gym: true },
    });

    await this.notifications.notify({
      recipientType: 'trainer', recipientId: manager.id, type: 'credentials_delivery',
      title: 'Your UV Active Branch Portal login',
      body: `Your branch "${gym.name}" is ready. Log in at the Branch Portal with email ${manager.email} and the temporary password below — you'll be asked to set up two-factor authentication on first login. Temporary password: ${temporaryPassword}`,
      channel: 'email', recipientAddress: manager.email,
    });

    return {
      gym,
      manager: {
        id: manager.id,
        name: manager.name,
        email: manager.email,
        // Present ONLY in this response — never re-fetchable afterward.
        temporaryPassword,
      },
    };
  }

  /** Own-branch profile for the Settings screen — same row as get(), just the branch's own view of it. */
  async getOwnProfile(gymId: string) {
    const gym = await this.get(gymId);
    const manager = await this.getManager(gymId);
    return { ...gym, manager };
  }

  async updateOwnProfile(gymId: string, dto: UpdateGymProfileDto) {
    await this.get(gymId);
    return this.prisma.gym.update({ where: { id: gymId }, data: dto });
  }

  /**
   * Everything the Dashboard screen needs in one call: member count vs
   * cap, today's sessions with enrollment, pending outgoing transfer
   * count, and the "needs reassignment" panel — which is only ever
   * populated (never just empty) so the frontend can decide whether to
   * render the panel at all, per design brief §3.2.
   */
  async getDashboard(gymId: string) {
    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);
    const endOfDay = new Date();
    endOfDay.setHours(23, 59, 59, 999);

    const [gym, memberCount, sessionsToday, pendingTransferCount, needsReassignment, trainerCount, sensorCount] = await Promise.all([
      this.get(gymId),
      this.prisma.member.count({ where: { currentGymId: gymId } }),
      this.prisma.session.findMany({
        where: { gymId, scheduledAt: { gte: startOfDay, lte: endOfDay } },
        include: { trainer: { select: { id: true, name: true } }, _count: { select: { members: true } } },
        orderBy: { scheduledAt: 'asc' },
      }),
      // Admin-initiated requests addressed to THIS gym, awaiting this
      // branch's own accept/decline (see TransferRequestsService.
      // acceptByBranch) — this branch's own outgoing invites awaiting
      // member consent aren't an action item for the branch, so they're
      // deliberately excluded here.
      this.prisma.transferRequest.count({ where: { toGymId: gymId, status: 'pending', requestedByType: 'admin' } }),
      this.prisma.session.findMany({
        where: { gymId, needsReassignment: true },
        include: { trainer: { select: { id: true, name: true } } },
        orderBy: { scheduledAt: 'asc' },
      }),
      this.prisma.trainer.count({ where: { gymId, role: 'trainer' } }),
      this.prisma.sensor.count({ where: { gymId } }),
    ]);

    return {
      memberCount,
      memberLimit: gym.memberLimit,
      sessionsToday,
      pendingTransferCount,
      needsReassignment,
      trainerCount,
      sensorCount,
    };
  }

  list() {
    return this.prisma.gym.findMany({ orderBy: { createdAt: 'desc' } });
  }

  async get(id: string) {
    const gym = await this.prisma.gym.findUnique({
      where: { id },
      include: { _count: { select: { currentMembers: true, trainers: true } } },
    });
    if (!gym) throw new NotFoundException('Gym not found.');
    return gym;
  }

  /** The gym's primary branch-manager account, for display on the admin Gym detail screen. */
  async getManager(id: string) {
    await this.get(id);
    const manager = await this.prisma.trainer.findFirst({
      where: { gymId: id, isPrimaryManager: true },
      select: { id: true, name: true, email: true, phone: true, status: true, totpEnabled: true, createdAt: true },
    });
    return manager;
  }

  /**
   * Admin-only edit of the manager's own name/email/phone — the branch
   * itself can't touch these (see UpdateGymProfileDto's comment; a
   * branch_manager can only change their own name via
   * TrainersService.updateManagerName). Email doubles as the Branch
   * Portal login, so a change here takes effect on the manager's next
   * login — existing sessions are left alone (unlike a password
   * change/reset, this isn't a credential compromise scenario).
   */
  async updateManager(id: string, dto: UpdateGymManagerDto, adminId: string) {
    await this.get(id);
    const manager = await this.prisma.trainer.findFirst({ where: { gymId: id, isPrimaryManager: true } });
    if (!manager) throw new NotFoundException('This gym has no primary manager account yet.');

    if (dto.email && dto.email !== manager.email) {
      const existing = await this.prisma.trainer.findUnique({ where: { email: dto.email } });
      if (existing) throw new ConflictException('A staff account with this email already exists.');
    }

    const updated = await this.prisma.trainer.update({
      where: { id: manager.id },
      data: { name: dto.name, email: dto.email, phone: dto.phone },
      select: { id: true, name: true, email: true, phone: true, status: true, totpEnabled: true, createdAt: true },
    });
    await this.auditLog.record({
      actorType: 'admin', actorId: adminId, action: 'trainer.update', targetType: 'trainer', targetId: manager.id,
      payload: { gymId: id, admin_edited_manager: true },
    });
    return updated;
  }

  async update(id: string, dto: UpdateGymDto, adminId: string) {
    await this.get(id);
    const gym = await this.prisma.gym.update({ where: { id }, data: dto });
    await this.auditLog.record({ actorType: 'admin', actorId: adminId, action: 'gym.update', targetType: 'gym', targetId: id, payload: { ...dto } });
    return gym;
  }

  /**
   * Issues a brand-new temporary password for the branch's primary
   * manager account (e.g. the original credentials email never
   * arrived, or the branch is locked out). Returns the plaintext once,
   * same handling as create(). Also revokes any existing sessions for
   * that account so an old, possibly-compromised password can't keep
   * working.
   */
  async resetManagerPassword(id: string, dto: ResetGymManagerPasswordDto, adminId: string) {
    await this.get(id);
    const manager = await this.prisma.trainer.findFirst({ where: { gymId: id, isPrimaryManager: true } });
    if (!manager) throw new NotFoundException('This gym has no primary manager account yet.');

    const temporaryPassword = dto.newPassword || generateTempPassword();
    const passwordHash = await hashSecret(temporaryPassword);
    await this.prisma.$transaction([
      this.prisma.trainer.update({ where: { id: manager.id }, data: { passwordHash } }),
      this.prisma.refreshToken.updateMany({ where: { trainerId: manager.id, revokedAt: null }, data: { revokedAt: new Date() } }),
    ]);

    await this.auditLog.record({ actorType: 'admin', actorId: adminId, action: 'trainer.password_reset', targetType: 'trainer', targetId: manager.id, payload: { gymId: id, admin_initiated: true } });
    await this.notifications.notify({
      recipientType: 'trainer', recipientId: manager.id, type: 'credentials_delivery',
      title: 'Your UV Active Branch Portal password was reset',
      body: `A UV Active admin reset your Branch Portal password. Temporary password: ${temporaryPassword}`,
      channel: 'email', recipientAddress: manager.email,
    });

    return { managerId: manager.id, email: manager.email, temporaryPassword };
  }

  /**
   * The suspension cascade in one place: bump token_version so every
   * already-issued staff JWT for this gym fails GymActiveGuard on its
   * very next request, and flip status so new logins are blocked too.
   */
  async suspend(id: string, adminId: string) {
    const gym = await this.get(id);
    const updated = await this.prisma.gym.update({
      where: { id },
      data: { status: 'suspended', tokenVersion: gym.tokenVersion + 1 },
    });
    await this.auditLog.record({ actorType: 'admin', actorId: adminId, action: 'gym.suspend', targetType: 'gym', targetId: id });
    return updated;
  }

  async activate(id: string, adminId: string) {
    const gym = await this.get(id);
    const updated = await this.prisma.gym.update({
      where: { id },
      data: { status: 'active', tokenVersion: gym.tokenVersion + 1 },
    });
    await this.auditLog.record({ actorType: 'admin', actorId: adminId, action: 'gym.activate', targetType: 'gym', targetId: id });
    return updated;
  }

  /** Soft delete only — status='deleted', never a hard DROP row (spec §5's stated delete-semantics rule). */
  async remove(id: string, adminId: string) {
    const memberCount = await this.prisma.member.count({ where: { currentGymId: id } });
    if (memberCount > 0) {
      throw new BadRequestException(`Cannot delete a gym with ${memberCount} member(s) still assigned. Release or transfer them first.`);
    }
    await this.get(id);
    await this.prisma.gym.update({ where: { id }, data: { status: 'deleted' } });
    await this.auditLog.record({ actorType: 'admin', actorId: adminId, action: 'gym.delete', targetType: 'gym', targetId: id });
    return { ok: true };
  }
}
