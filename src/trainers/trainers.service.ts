import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AuditLogService } from '../audit-log/audit-log.service';
import { NotificationsService } from '../notifications/notifications.service';
import { SessionsService } from '../sessions/sessions.service';
import { hashSecret } from '../common/utils/hash.util';
import { generateTempPassword } from '../common/utils/id-generator';
import { CreateTrainerDto, UpdateTrainerDto } from './trainers.dto';

@Injectable()
export class TrainersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditLog: AuditLogService,
    private readonly notifications: NotificationsService,
    private readonly sessions: SessionsService,
  ) {}

  /**
   * Password is server-generated and delivered by email exactly once —
   * same pattern as the gym's auto-created branch-manager account
   * (GymsService.create). Never client-supplied: a branch manager
   * typing a trainer's initial password was the previous behavior and
   * meant credentials existed in the manager's head/notes before ever
   * reaching the trainer.
   */
  async create(gymId: string, dto: CreateTrainerDto, actorId: string) {
    const existing = await this.prisma.trainer.findUnique({ where: { email: dto.email } });
    if (existing) throw new ConflictException('A staff account with this email already exists.');
    const temporaryPassword = generateTempPassword();
    const passwordHash = await hashSecret(temporaryPassword);
    const trainer = await this.prisma.trainer.create({
      data: { gymId, name: dto.name, email: dto.email, passwordHash, phone: dto.phone, role: 'trainer' },
    });
    await this.auditLog.record({ actorType: 'staff', actorId, action: 'trainer.create', targetType: 'trainer', targetId: trainer.id, payload: { gymId, role: trainer.role } });

    const gym = await this.prisma.gym.findUnique({ where: { id: gymId }, select: { name: true } });
    await this.notifications.notify({
      recipientType: 'trainer', recipientId: trainer.id, type: 'credentials_delivery',
      title: 'Your UV Active Branch Portal login',
      body: `You've been added as a trainer at "${gym?.name ?? 'your branch'}". Log in at the Branch Portal with email ${trainer.email} and the temporary password below — you'll be asked to set up two-factor authentication on first login. Temporary password: ${temporaryPassword}`,
      channel: 'email', recipientAddress: trainer.email,
    });

    return this.publicShape(trainer);
  }

  listForGym(gymId: string) {
    return this.prisma.trainer
      .findMany({ where: { gymId, removedAt: null, role: 'trainer' }, orderBy: { name: 'asc' } })
      .then((rows) => rows.map(this.publicShape));
  }

  // `trainersOnly` powers the Admin Panel Trainers screen, which must
  // never surface branch managers in a list titled "Trainers" — those
  // are shown on the Gyms screen instead (GymsService.getManager). The
  // Branch Portal's own trainer list (listForGym) never included
  // managers in the first place, since branch_manager rows only ever
  // come from GymsService.create.
  listAll(trainersOnly = false) {
    return this.prisma.trainer
      .findMany({
        where: { removedAt: null, ...(trainersOnly ? { role: 'trainer' as const } : {}) },
        include: { gym: { select: { id: true, name: true } } },
        orderBy: { createdAt: 'desc' },
      })
      .then((rows) => rows.map(this.publicShape));
  }

  async get(id: string) {
    const trainer = await this.prisma.trainer.findUnique({
      where: { id },
      include: {
        gym: { select: { id: true, name: true } },
        sessions: { orderBy: { scheduledAt: 'desc' }, take: 50, include: { _count: { select: { members: true } } } },
      },
    });
    if (!trainer) throw new NotFoundException('Trainer not found.');
    return this.publicShape(trainer);
  }

  async update(id: string, gymId: string, dto: UpdateTrainerDto) {
    const trainer = await this.prisma.trainer.findUnique({ where: { id } });
    if (!trainer || trainer.gymId !== gymId || trainer.removedAt) throw new NotFoundException('Trainer not found in your branch.');
    if (trainer.role !== 'trainer') {
      // Closes a real gap: without this, a branch manager could PATCH
      // their own row (they're a Trainer row too) and change their own
      // phone number — exactly what the Settings restriction forbids.
      // Their name is changed via updateManagerName() above instead.
      throw new ConflictException("Branch managers aren't edited through the Trainer tab.");
    }
    return this.publicShape(await this.prisma.trainer.update({ where: { id }, data: dto }));
  }

  // Soft delete — a hard DELETE would break the FK every past session
  // still holds to this row (needed to keep showing "Trainer: X" on old
  // leaderboards). Blocked while they still have upcoming sessions on
  // the books; the branch has to reassign or cancel those first, same
  // rule as suspension already enforces via needsReassignment.
  // `scopeGymId` is required for the branch-initiated path and omitted
  // for the admin-initiated one (admin can remove any trainer
  // cross-branch — the audit log records it as an admin override).
  async remove(id: string, scopeGymId: string | undefined, actorType: 'staff' | 'admin', actorId: string) {
    const trainer = await this.prisma.trainer.findUnique({ where: { id } });
    if (!trainer || trainer.removedAt) throw new NotFoundException('Trainer not found.');
    if (scopeGymId && trainer.gymId !== scopeGymId) throw new NotFoundException('Trainer not found in your branch.');
    if (trainer.role !== 'trainer') throw new ConflictException("Branch managers can't be removed from the Trainer tab.");

    const upcoming = await this.prisma.session.count({
      where: { trainerId: id, status: { in: ['scheduled', 'in_progress'] } },
    });
    if (upcoming > 0) {
      throw new ConflictException(`${trainer.name} still has ${upcoming} upcoming session(s) — reassign or cancel those first.`);
    }

    await this.prisma.trainer.update({ where: { id }, data: { removedAt: new Date(), status: 'suspended' } });
    await this.auditLog.record({
      actorType, actorId, action: 'trainer.remove', targetType: 'trainer', targetId: id,
      payload: { gymId: trainer.gymId, admin_override: actorType === 'admin' },
    });
    return { removed: true };
  }

  /**
   * Admin- or branch-manager-triggered password reset for a trainer
   * account: generates a fresh temporary password server-side, revokes
   * every existing session for that account, and delivers the new
   * password by email exactly once — same handling as the gym-manager
   * reset (GymsService.resetManagerPassword). `scopeGymId` is required
   * for the branch path (a manager can only reset passwords at their
   * own branch) and omitted for the admin path (cross-branch). Returns
   * the plaintext once; never stored or logged afterwards.
   */
  async resetPassword(id: string, scopeGymId: string | undefined, actorType: 'staff' | 'admin', actorId: string) {
    const trainer = await this.prisma.trainer.findUnique({ where: { id } });
    if (!trainer || trainer.removedAt) throw new NotFoundException('Trainer not found.');
    if (scopeGymId && trainer.gymId !== scopeGymId) throw new NotFoundException('Trainer not found in your branch.');

    const temporaryPassword = generateTempPassword();
    const passwordHash = await hashSecret(temporaryPassword);
    await this.prisma.$transaction([
      this.prisma.trainer.update({ where: { id }, data: { passwordHash } }),
      this.prisma.refreshToken.updateMany({ where: { trainerId: id, revokedAt: null }, data: { revokedAt: new Date() } }),
    ]);

    await this.auditLog.record({
      actorType, actorId, action: 'trainer.password_reset', targetType: 'trainer', targetId: id,
      payload: { gymId: trainer.gymId, admin_override: actorType === 'admin' },
    });
    await this.notifications.notify({
      recipientType: 'trainer', recipientId: trainer.id, type: 'credentials_delivery',
      title: 'Your UV Active password was reset',
      body: `Your Branch Portal / Trainer App password was reset. Temporary password: ${temporaryPassword}`,
      channel: 'email', recipientAddress: trainer.email,
    });

    return { trainerId: trainer.id, email: trainer.email, temporaryPassword };
  }

  /**
   * Independent from gym-level suspension: suspending one trainer never
   * touches the gym or its peers (spec §3.5) — but suspending a trainer
   * DOES cascade to their own future sessions (spec §8): every
   * scheduled session they own gets flagged needs_reassignment=true,
   * and the branch is notified so it's surfaced on the dashboard, not
   * left as a silent background flag. `scopeGymId` is required for the
   * branch-initiated path and omitted for the admin-initiated one
   * (admin can act cross-branch).
   */
  async setStatus(id: string, status: 'active' | 'suspended', actorType: 'staff' | 'admin', actorId: string, scopeGymId?: string) {
    const trainer = await this.prisma.trainer.findUnique({ where: { id } });
    if (!trainer) throw new NotFoundException('Trainer not found.');
    if (scopeGymId && trainer.gymId !== scopeGymId) throw new NotFoundException('Trainer not found in your branch.');

    const updated = await this.prisma.trainer.update({ where: { id }, data: { status } });
    await this.auditLog.record({ actorType, actorId, action: `trainer.${status}`, targetType: 'trainer', targetId: id, payload: { admin_override: actorType === 'admin' } });

    if (status === 'suspended') {
      const flaggedCount = await this.sessions.flagSessionsForReassignment(id);
      if (flaggedCount > 0) {
        await this.notifications.notify({
          recipientType: 'branch', recipientId: trainer.gymId, type: 'reassignment_needed',
          title: 'Sessions need reassignment',
          body: `${trainer.name} was suspended and has ${flaggedCount} upcoming session(s) that need a new trainer.`,
          data: { trainerId: id, count: flaggedCount },
        });
      }
    }
    return this.publicShape(updated);
  }

  // Settings screen (Branch Portal) — the ONLY thing about their own
  // manager account a branch can change themselves. Email and phone
  // are deliberately excluded even from this narrow path (spec: "not
  // the email id of manager and phone number — cannot get changed,
  // only by admin can do"); this is why it's a dedicated method rather
  // than reusing the generic trainer update() below, which callers
  // shouldn't be able to reach for their own branch_manager row anyway.
  async updateManagerName(gymId: string, actorId: string, name: string) {
    const manager = await this.prisma.trainer.findFirst({ where: { gymId, isPrimaryManager: true } });
    if (!manager) throw new NotFoundException('No branch manager found for this gym.');
    const updated = await this.prisma.trainer.update({ where: { id: manager.id }, data: { name } });
    await this.auditLog.record({ actorType: 'staff', actorId, action: 'trainer.update_own_name', targetType: 'trainer', targetId: manager.id, payload: { gymId } });
    return this.publicShape(updated);
  }

  // Self-service — works for EITHER role, since it's always "editing
  // myself", not "a manager editing someone on their roster" (that's
  // update() above, deliberately blocked for branch_manager targets).
  // A branch manager changing their own name here is equivalent to
  // updateManagerName() above; both end up writing the same field on
  // the same row, this just doesn't require them to go through the
  // Settings-specific route to do it from the Trainer App.
  async updateSelf(trainerId: string, dto: { name?: string; phone?: string }) {
    const trainer = await this.prisma.trainer.findUnique({ where: { id: trainerId } });
    if (!trainer || trainer.removedAt) throw new NotFoundException('Account not found.');
    const updated = await this.prisma.trainer.update({ where: { id: trainerId }, data: dto });
    await this.auditLog.record({ actorType: 'staff', actorId: trainerId, action: 'trainer.update_self', targetType: 'trainer', targetId: trainerId });
    return this.publicShape(updated);
  }

  private publicShape(t: any) {
    const { passwordHash, ...rest } = t;
    return rest;
  }
}
