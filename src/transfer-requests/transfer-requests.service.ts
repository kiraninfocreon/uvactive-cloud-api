import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AuditLogService } from '../audit-log/audit-log.service';
import { NotificationsService } from '../notifications/notifications.service';
import { MembersService } from '../members/members.service';
import { AppException } from '../common/exceptions/app.exception';

const EXPIRY_WINDOW_HOURS = 48;

@Injectable()
export class TransferRequestsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditLog: AuditLogService,
    private readonly notifications: NotificationsService,
    private readonly members: MembersService,
  ) {}

  // ── Branch-initiated: "join our gym" request to a member elsewhere ──
  async createFromBranch(toGymId: string, memberId: string, actorTrainerId: string) {
    const member = await this.prisma.member.findUnique({ where: { id: memberId } });
    if (!member) throw new NotFoundException('Member not found.');
    if (member.currentGymId === toGymId) throw new BadRequestException('This member is already at your branch.');

    const existingPending = await this.prisma.transferRequest.findFirst({
      where: { memberId, toGymId, status: 'pending' },
    });
    if (existingPending) throw new BadRequestException('A pending request already exists for this member and branch.');

    const request = await this.prisma.transferRequest.create({
      data: {
        memberId,
        fromGymId: member.currentGymId,
        toGymId,
        requestedByType: 'branch',
        requestedById: actorTrainerId,
        expiresAt: new Date(Date.now() + EXPIRY_WINDOW_HOURS * 3600 * 1000),
      },
    });

    await this.auditLog.record({ actorType: 'staff', actorId: actorTrainerId, action: 'transfer.create', targetType: 'transfer_request', targetId: request.id, payload: { memberId, toGymId } });

    if (member.phone) {
      await this.notifications.notify({
        recipientType: 'member', recipientId: memberId, type: 'transfer_created',
        title: 'Gym transfer request', body: 'A gym wants to add you as a member on UV Active. Open the app to accept or decline.',
        channel: 'sms', recipientAddress: member.phone,
      });
    } else {
      await this.notifications.notify({
        recipientType: 'member', recipientId: memberId, type: 'transfer_created',
        title: 'Gym transfer request', body: 'A gym wants to add you as a member on UV Active. Open the app to accept or decline.',
      });
    }
    return request;
  }

  // ── Admin-initiated consent request (rare — admin usually uses the direct override in MembersService.adminAssign instead) ──
  async createFromAdmin(toGymId: string, memberId: string, adminId: string) {
    const member = await this.prisma.member.findUnique({ where: { id: memberId } });
    if (!member) throw new NotFoundException('Member not found.');
    if (member.currentGymId === toGymId) throw new BadRequestException('This member is already at that gym.');

    const request = await this.prisma.transferRequest.create({
      data: {
        memberId, fromGymId: member.currentGymId, toGymId,
        requestedByType: 'admin', requestedById: adminId,
        expiresAt: new Date(Date.now() + EXPIRY_WINDOW_HOURS * 3600 * 1000),
      },
    });
    await this.auditLog.record({ actorType: 'admin', actorId: adminId, action: 'transfer.create', targetType: 'transfer_request', targetId: request.id, payload: { memberId, toGymId, admin_override: false } });

    // Admin-initiated requests are accepted/declined by the receiving
    // BRANCH, not the member — this is not a member-consent flow like
    // the branch-initiated one below (spec: "admin can send a transfer
    // request to the branch portal, not completely assign to the
    // branch — branch needed to accept or decline it").
    await this.notifications.notify({
      recipientType: 'branch', recipientId: toGymId, type: 'transfer_created',
      title: 'New member transfer request', body: `An admin wants to add ${member.name} to your gym. Review it in Members → Transfer Requests.`,
    });
    return request;
  }

  // ── Branch responds to an admin-initiated request ────────────────────
  async acceptByBranch(id: string, gymId: string, actorTrainerId: string) {
    const request = await this.getOwnedPendingAdminRequest(id, gymId);
    await this.members.applyTransfer(request.memberId, gymId, 'branch_accepted_admin_transfer');
    const updated = await this.prisma.transferRequest.update({ where: { id }, data: { status: 'accepted', respondedAt: new Date() } });
    await this.auditLog.record({ actorType: 'staff', actorId: actorTrainerId, action: 'transfer.branch_accept', targetType: 'transfer_request', targetId: id, payload: { gymId } });
    return updated;
  }

  async declineByBranch(id: string, gymId: string, actorTrainerId: string) {
    const request = await this.getOwnedPendingAdminRequest(id, gymId);
    const updated = await this.prisma.transferRequest.update({ where: { id }, data: { status: 'declined', respondedAt: new Date() } });
    await this.auditLog.record({ actorType: 'staff', actorId: actorTrainerId, action: 'transfer.branch_decline', targetType: 'transfer_request', targetId: id, payload: { gymId } });
    return updated;
  }

  private async getOwnedPendingAdminRequest(id: string, gymId: string) {
    const request = await this.prisma.transferRequest.findUnique({ where: { id } });
    if (!request) throw new NotFoundException('Transfer request not found.');
    if (request.toGymId !== gymId) throw new ForbiddenException('This request is not addressed to your branch.');
    if (request.requestedByType !== 'admin') {
      throw new BadRequestException('Only admin-initiated requests are accepted/declined by the branch — branch-initiated requests wait on the member.');
    }
    if (request.status !== 'pending') throw new AppException('TRANSFER_ALREADY_RESPONDED', `This request is already ${request.status}.`, 400);
    if (request.expiresAt < new Date()) throw new BadRequestException('This request has expired.');
    return request;
  }

  listForGym(gymId: string) {
    return this.prisma.transferRequest.findMany({
      where: { toGymId: gymId },
      include: {
        member: {
          select: {
            id: true, name: true, memberCode: true, photoUrl: true,
            sex: true, ageYears: true, heightCm: true, weightKg: true, restingHr: true,
          },
        },
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  listPendingForMember(memberId: string) {
    // Admin-initiated requests are excluded — those are accepted/
    // declined by the branch (see acceptByBranch/declineByBranch), not
    // surfaced to the member at all.
    return this.prisma.transferRequest.findMany({
      where: { memberId, status: 'pending', requestedByType: 'branch' },
      include: { toGym: { select: { id: true, name: true } } },
      orderBy: { createdAt: 'desc' },
    });
  }

  async accept(id: string, memberId: string) {
    const request = await this.getOwnedPending(id, memberId);
    await this.members.applyConsentTransfer(memberId, request.toGymId);
    const updated = await this.prisma.transferRequest.update({ where: { id }, data: { status: 'accepted', respondedAt: new Date() } });
    if (request.requestedByType === 'branch' && request.requestedById) {
      await this.notifications.notify({ recipientType: 'branch', recipientId: request.toGymId, type: 'transfer_accepted', body: 'A member accepted your transfer request.' });
    }
    return updated;
  }

  async decline(id: string, memberId: string) {
    const request = await this.getOwnedPending(id, memberId);
    await this.auditLog.record({ actorType: 'member', actorId: memberId, action: 'transfer.decline', targetType: 'transfer_request', targetId: id });
    const updated = await this.prisma.transferRequest.update({ where: { id }, data: { status: 'declined', respondedAt: new Date() } });
    await this.notifications.notify({ recipientType: 'branch', recipientId: request.toGymId, type: 'transfer_declined', body: 'A member declined your transfer request.' });
    return updated;
  }

  private async getOwnedPending(id: string, memberId: string) {
    const request = await this.prisma.transferRequest.findUnique({ where: { id } });
    if (!request) throw new NotFoundException('Transfer request not found.');
    if (request.memberId !== memberId) throw new ForbiddenException('This request is not addressed to you.');
    if (request.status !== 'pending') throw new AppException('TRANSFER_ALREADY_RESPONDED', `This request is already ${request.status}.`, 400);
    if (request.expiresAt < new Date()) {
      throw new BadRequestException('This request has expired.');
    }
    return request;
  }

  /** Scheduled job entry point — flips stale pending requests to expired. */
  async expireStaleRequests(): Promise<number> {
    const result = await this.prisma.transferRequest.updateMany({
      where: { status: 'pending', expiresAt: { lt: new Date() } },
      data: { status: 'expired' },
    });
    return result.count;
  }
}
