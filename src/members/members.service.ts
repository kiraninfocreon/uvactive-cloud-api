import { BadRequestException, ForbiddenException, Injectable, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { randomInt } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { AuditLogService } from '../audit-log/audit-log.service';
import { NotificationsService } from '../notifications/notifications.service';
import { generateMemberCode, generatePin, generateTempPassword } from '../common/utils/id-generator';
import { hashSecret, verifySecret } from '../common/utils/hash.util';
import { AdminRegisterMemberDto, RegisterMemberDto, UpdateMemberDto, AdminAssignMemberDto, MemberSelfUpdateDto } from './members.dto';
import { AppException } from '../common/exceptions/app.exception';
import { zoneForBpm } from '../common/hr.util';

const OTP_TTL_MINUTES = 10;

@Injectable()
export class MembersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditLog: AuditLogService,
    private readonly notifications: NotificationsService,
  ) {}

  // ── Branch Portal registration ──────────────────────────────────────
  // Member-cap enforcement lives here, not just as a UI hint (Cloud API
  // spec §3.3) — the count check and the insert happen inside the same
  // transaction. member_code/pin are generated server-side only; on
  // collision (astronomically unlikely at this alphabet length, but
  // never assumed) we retry rather than trust uniqueness blindly.
  // Consent is captured in the same transaction as the member row —
  // there is no member without a logged consent (spec §10).
  async registerByBranch(gymId: string, dto: RegisterMemberDto, actorTrainerId: string, ip: string) {
    if (!dto.consentAccepted) {
      throw new BadRequestException('The member must consent to data processing before registration can proceed.');
    }

    const plainPin = generatePin();
    const pinHash = await hashSecret(plainPin);
    // Web/portal login password — separate credential from the PIN
    // (which stays the kiosk/QR-facing one). Generated server-side,
    // same as everywhere else in this codebase: never client-supplied,
    // shown to the member exactly once via the credentials email below.
    const plainPassword = generateTempPassword();
    const passwordHash = await hashSecret(plainPassword);

    const member = await this.prisma.$transaction(async (tx) => {
      const gym = await tx.gym.findUnique({ where: { id: gymId } });
      if (!gym) throw new NotFoundException('Gym not found.');
      const count = await tx.member.count({ where: { currentGymId: gymId } });
      if (count >= gym.memberLimit) {
        throw new AppException('MEMBER_LIMIT_REACHED', `This branch is at its member cap (${gym.memberLimit}). Release a member or raise the cap before registering another.`, 400);
      }

      const memberCode = await this.generateUniqueMemberCode(tx);
      const created = await tx.member.create({
        data: {
          memberCode,
          pinHash,
          passwordHash,
          name: dto.name,
          phone: dto.phone,
          email: dto.email,
          dob: dto.dob ? new Date(dto.dob) : undefined,
          sex: dto.sex,
          ageYears: dto.ageYears,
          heightCm: dto.heightCm,
          weightKg: dto.weightKg,
          restingHr: dto.restingHr,
          photoUrl: dto.photoUrl,
          currentGymId: gymId,
        },
      });
      await tx.memberGymHistory.create({ data: { memberId: created.id, gymId, joinedAt: new Date() } });
      await tx.consent.create({ data: { memberId: created.id, version: dto.consentVersion, ipAddress: ip } });
      return created;
    });

    await this.auditLog.record({
      actorType: 'staff', actorId: actorTrainerId, action: 'member.register', targetType: 'member', targetId: member.id,
      payload: { gymId, memberCode: member.memberCode, consentVersion: dto.consentVersion },
    });

    // Credentials delivered exactly once, here — must-deliver, never
    // re-displayable through any endpoint afterward (spec §6, §11).
    // Email now carries both login paths: memberCode+PIN (kiosk/QR/
    // Member App) and email+password (web portal), since email is
    // mandatory on registration going forward.
    if (member.phone) {
      await this.notifications.notify({
        recipientType: 'member', recipientId: member.id, type: 'credentials_delivery',
        title: 'Welcome to UV Active', body: `Your member ID is ${member.memberCode} and PIN is ${plainPin}. Keep these safe.`,
        channel: 'sms', recipientAddress: member.phone,
      });
    }
    await this.notifications.notify({
      recipientType: 'member', recipientId: member.id, type: 'credentials_delivery',
      title: 'Your UV Active login details',
      body: `Welcome to UV Active! Your member ID is ${member.memberCode} with PIN ${plainPin} for the Member App and kiosk check-in. You can also sign in to the member web portal with your email (${member.email}) and password: ${plainPassword}`,
      channel: 'email', recipientAddress: member.email ?? undefined,
    });

    // Product decision (superseding the original design brief §3.3):
    // Branch Portal desk staff hand the member their ID + PIN on the
    // spot at registration, so the plaintext PIN is returned here once,
    // same as resetPin() already does below. Still also sent by
    // SMS/email as a backup the member can refer back to later.
    return { ...this.publicShape(member), pin: plainPin };
  }

  // ── Admin Panel registration ────────────────────────────────────────
  // Admin-created members start unassigned (currentGymId null) — no gym
  // is picked here, since the spec routes gym placement through the
  // transfer-request flow (branch accepts), never a direct assign at
  // creation time. No member-cap check applies for the same reason —
  // the cap is only ever checked when the member actually joins a gym
  // (registerByBranch / applyConsentTransfer).
  //
  // There's no member physically present to capture consent from at an
  // admin desk, so this records a system consent row instead of
  // skipping consent capture altogether — keeps the audit trail
  // guarantee (every member has a logged consent row) intact.
  async registerByAdmin(dto: AdminRegisterMemberDto, adminId: string, ip: string) {
    const plainPin = generatePin();
    const pinHash = await hashSecret(plainPin);
    const plainPassword = generateTempPassword();
    const passwordHash = await hashSecret(plainPassword);

    const member = await this.prisma.$transaction(async (tx) => {
      const memberCode = await this.generateUniqueMemberCode(tx);
      const created = await tx.member.create({
        data: {
          memberCode,
          pinHash,
          passwordHash,
          name: dto.name,
          phone: dto.phone,
          email: dto.email,
          sex: dto.sex,
          ageYears: dto.ageYears,
          heightCm: dto.heightCm,
          weightKg: dto.weightKg,
          restingHr: dto.restingHr,
        },
      });
      await tx.consent.create({ data: { memberId: created.id, version: 'admin-created-v1', ipAddress: ip } });
      return created;
    });

    await this.auditLog.record({
      actorType: 'admin', actorId: adminId, action: 'member.register', targetType: 'member', targetId: member.id,
      payload: { memberCode: member.memberCode, admin_created: true },
    });

    await this.notifications.notify({
      recipientType: 'member', recipientId: member.id, type: 'credentials_delivery',
      title: 'Your UV Active login details',
      body: `Welcome to UV Active! Your member ID is ${member.memberCode} with PIN ${plainPin} for the Member App and kiosk check-in. You can also sign in to the member web portal with your email (${member.email}) and password: ${plainPassword}`,
      channel: 'email', recipientAddress: member.email ?? undefined,
    });

    // Same reveal-once-at-creation treatment as registerByBranch — the
    // Admin Panel's create-member success screen shows this directly.
    return { ...this.publicShape(member), pin: plainPin };
  }

  private async generateUniqueMemberCode(tx: Prisma.TransactionClient): Promise<string> {
    for (let attempt = 0; attempt < 5; attempt++) {
      const code = generateMemberCode();
      const existing = await tx.member.findUnique({ where: { memberCode: code } });
      if (!existing) return code;
    }
    throw new Error('Could not generate a unique member code after 5 attempts — check the alphabet/length.');
  }

  // ── Rosters & lookups ────────────────────────────────────────────────
  listForGym(gymId: string) {
    return this.prisma.member.findMany({ where: { currentGymId: gymId }, orderBy: { name: 'asc' } });
  }

  /**
   * Platform-wide search by exact member_code, minimal fields only
   * (spec §16) — name + current-gym status, never phone/email/DOB —
   * so it can't be used to enumerate the member base. Rate limiting
   * per staff account should sit in front of this route in addition
   * to normal auth (see README).
   */
  async searchByCode(code: string) {
    const member = await this.prisma.member.findUnique({
      where: { memberCode: code },
      select: { id: true, memberCode: true, name: true, status: true, currentGymId: true },
    });
    if (!member) throw new NotFoundException('No member found with that ID.');
    return member;
  }

  async getFullDetail(id: string) {
    const member = await this.prisma.member.findUnique({
      where: { id },
      include: {
        currentGym: true,
        gymHistory: { include: { gym: true }, orderBy: { joinedAt: 'desc' } },
        sessionMembers: { include: { session: true }, orderBy: { enrolledAt: 'desc' }, take: 50 },
      },
    });
    if (!member) throw new NotFoundException('Member not found.');
    return member;
  }

  // Branch Portal's full member-detail screen: bio + every session
  // they've done at THIS gym + a raw HR-tick stream for the all-
  // sessions graph. Scoped to gymId — a branch can't pull up a member's
  // full profile if that member never belonged to their gym (even if
  // they can see the member in a shared session's leaderboard).
  async getProfileForBranch(memberId: string, gymId: string) {
    const member = await this.prisma.member.findUnique({ where: { id: memberId } });
    if (!member) throw new NotFoundException('Member not found.');

    const everAtThisGym = member.currentGymId === gymId || (await this.prisma.memberGymHistory.findFirst({ where: { memberId, gymId } }));
    if (!everAtThisGym) throw new NotFoundException('Member not found.');

    const sessionMembers = await this.prisma.sessionMember.findMany({
      where: { memberId, session: { gymId } },
      include: { session: true },
      orderBy: { enrolledAt: 'desc' },
    });

    const sessions = sessionMembers.map((sm) => ({
      sessionId: sm.sessionId,
      sessionName: sm.session.name,
      startedAt: sm.session.startedAt ?? sm.session.scheduledAt ?? sm.session.createdAt,
      endedAt: sm.session.endedAt,
      avgHr: sm.avgHr,
      peakHr: sm.maxHr,
      calories: sm.calories,
      score: sm.score,
      zoneMinutes: sm.zoneMinutes,
      // Rich post-workout results (spec §7) — surfaced on the member's
      // session-history rows so portals can show the full breakdown.
      sweatPoints: sm.sweatPoints,
      recoveryPoints: sm.recoveryPoints,
      recoveryGrade: sm.recoveryGrade,
      epocCalories: sm.epocCalories,
      epocHours: sm.epocHours,
      avgPctMhr: sm.avgPctMhr,
      maxPctMhr: sm.maxPctMhr,
      finalRank: sm.finalRank,
      consistencyPct: sm.consistencyPct,
    }));

    // One "Full Zone View" graph across every session this member has
    // done. A single findMany ordered by ts desc + a flat take(500)
    // looks reasonable but is a real bug: with a tick roughly every
    // second, 500 rows is ~8 minutes — and because the cap applies
    // globally (not per session), those 500 rows are almost always
    // ALL from the single most recent session. Every older session's
    // ticks get silently dropped, so "Full Zone View" (and this being
    // the only source for the full-history graph) rendered as if the
    // member had one session, always the latest one — reported as
    // "clicking the zone colour button shows the last session graph".
    // Fix: sample per session-member instead of one global query, so
    // every session contributes ticks to the combined graph.
    //
    // Second fix (retention-related): the per-session downsampled
    // chartSeries (written once at session-end, permanent) is the
    // preferred source for every session that has one — the raw
    // sensor_readings table is purged nightly past
    // RAW_READING_RETENTION_DAYS, so reading it directly here silently
    // dropped every session older than ~2 weeks from this graph even
    // though its per-session graph (a different, chartSeries-backed
    // path) kept working forever. Raw readings are now only sampled as
    // a fallback for sessions with no chartSeries yet (in-progress or
    // legacy pre-chartSeries rows).
    const RECENT_SESSIONS_FOR_GRAPH = 20;
    const TICKS_PER_SESSION = 120;
    const graphSessionMembers = sessionMembers.slice(0, RECENT_SESSIONS_FOR_GRAPH);
    const hrRowsPerSession = await Promise.all(
      graphSessionMembers.map(async (sm) => {
        const series = sm.chartSeries as { t: number[]; hr: number[] } | null;
        if (series && Array.isArray(series.t) && Array.isArray(series.hr) && series.t.length > 0) {
          // Downsampled permanent series — the retention-safe path.
          const step = Math.max(1, Math.ceil(series.t.length / TICKS_PER_SESSION));
          const rows: { ts: number; hr: number }[] = [];
          for (let i = 0; i < series.t.length; i += step) {
            rows.push({ ts: series.t[i], hr: series.hr[i] });
          }
          return rows;
        }
        // No chartSeries yet — fall back to the raw log (in-progress
        // session or legacy row written before chartSeries existed).
        const raw = await this.prisma.sensorReading.findMany({
          where: { sessionMemberId: sm.id },
          orderBy: { ts: 'asc' },
          take: TICKS_PER_SESSION,
        });
        return raw.map((r) => ({ ts: r.ts.getTime(), hr: r.hr }));
      }),
    );
    const hrRows = hrRowsPerSession.flat().sort((a, b) => a.ts - b.ts);
    const hrTicks = hrRows.map((r) => {
      const { zone, pctMhr } = zoneForBpm(r.hr, member.ageYears, member.sex);
      return { ts: r.ts, bpm: r.hr, zone, pctMhr: Math.round(pctMhr * 10) / 10 };
    });

    const withAvg = sessionMembers.filter((sm) => sm.avgHr != null);
    const avgBpmOverall = withAvg.length ? withAvg.reduce((sum, sm) => sum + (sm.avgHr ?? 0), 0) / withAvg.length : null;

    return { member, sessions, avgBpmOverall, hrTicks };
  }

  async listAll(params: { skip?: number; take?: number }) {
    const skip = params.skip ?? 0;
    const take = params.take ?? 50;
    const [data, total] = await Promise.all([
      this.prisma.member.findMany({
        skip, take, orderBy: { createdAt: 'desc' },
        include: { currentGym: { select: { id: true, name: true } } },
      }),
      this.prisma.member.count(),
    ]);
    return { data, meta: { skip, take, total } };
  }

  async updateProfile(id: string, dto: UpdateMemberDto, scopeGymId?: string) {
    const member = await this.prisma.member.findUnique({ where: { id } });
    if (!member) throw new NotFoundException('Member not found.');
    if (member.isAnonymized) throw new BadRequestException('This member account has been closed.');
    if (scopeGymId && member.currentGymId !== scopeGymId) {
      throw new ForbiddenException('This member is not currently assigned to your branch.');
    }
    return this.prisma.member.update({
      where: { id },
      data: { ...dto, dob: dto.dob ? new Date(dto.dob) : undefined },
    });
  }

  // ── Release (branch-initiated, no consent needed — it's their own roster) ──
  // Release also cleans up the member's FUTURE bookings at this gym in
  // the same transaction: every scheduled session they're still enrolled
  // in loses them as a participant, so a trainer can't later end one of
  // those sessions and score a member who was already released. Past /
  // in-progress sessions stay untouched — those are historical record.
  // Enrolled members are notified so nobody shows up expecting them.
  async releaseFromGym(id: string, gymId: string, actorType: 'staff' | 'admin', actorId: string, reason?: string) {
    const member = await this.prisma.member.findUnique({ where: { id } });
    if (!member) throw new NotFoundException('Member not found.');
    if (member.currentGymId !== gymId) throw new ForbiddenException('This member is not currently assigned to this branch.');

    const futureEnrollments = await this.prisma.sessionMember.findMany({
      where: { memberId: id, session: { gymId, status: 'scheduled' } },
      select: { session: { select: { id: true, name: true, trainerId: true } } },
    });

    await this.prisma.$transaction(async (tx) => {
      await tx.memberGymHistory.updateMany({
        where: { memberId: id, gymId, leftAt: null },
        data: { leftAt: new Date(), releasedByType: actorType, releasedById: actorId, reason },
      });
      await tx.member.update({ where: { id }, data: { currentGymId: null } });
      if (futureEnrollments.length > 0) {
        await tx.sessionMember.deleteMany({
          where: { memberId: id, session: { gymId, status: 'scheduled' } },
        });
      }
    });

    await this.auditLog.record({
      actorType, actorId, action: 'member.release', targetType: 'member', targetId: id,
      payload: { fromGymId: gymId, reason, admin_override: actorType === 'admin', cancelledFutureBookings: futureEnrollments.length },
    });

    // Let the affected trainers know the roster just shrank for a
    // session they're running, so they don't expect this member to
    // walk in. Fire-and-forget-ish, same as session-create notices.
    for (const e of futureEnrollments) {
      await this.notifications.notify({
        recipientType: 'trainer', recipientId: e.session.trainerId, type: 'member_released_from_session',
        title: 'Member released from session',
        body: `${member.name} was released from the branch and removed from "${e.session.name}".`,
        data: { sessionId: e.session.id },
      });
    }
    return { ok: true };
  }

  // ── Admin override assign (bypasses member consent — logged prominently) ──
  async adminAssign(id: string, dto: AdminAssignMemberDto, adminId: string) {
    const [member, targetGym] = await Promise.all([
      this.prisma.member.findUnique({ where: { id } }),
      this.prisma.gym.findUnique({ where: { id: dto.gymId } }),
    ]);
    if (!member) throw new NotFoundException('Member not found.');
    if (!targetGym) throw new NotFoundException('Target gym not found.');
    if (targetGym.status !== 'active') throw new BadRequestException('Cannot assign a member to a suspended gym.');

    const memberCount = await this.prisma.member.count({ where: { currentGymId: dto.gymId } });
    if (memberCount >= targetGym.memberLimit) {
      throw new AppException('MEMBER_LIMIT_REACHED', `Target gym is at its member cap (${targetGym.memberLimit}).`, 400);
    }

    await this.prisma.$transaction(async (tx) => {
      if (member.currentGymId) {
        await tx.memberGymHistory.updateMany({
          where: { memberId: id, gymId: member.currentGymId, leftAt: null },
          data: { leftAt: new Date(), releasedByType: 'admin', releasedById: adminId, reason: dto.reason },
        });
      }
      await tx.memberGymHistory.create({ data: { memberId: id, gymId: dto.gymId, joinedAt: new Date() } });
      await tx.member.update({ where: { id }, data: { currentGymId: dto.gymId } });
    });

    // Flagged admin_override: true — this is the one path that skips
    // member consent, so it needs to be unambiguous in the audit trail
    // for dispute resolution (spec §3.4).
    await this.auditLog.record({
      actorType: 'admin', actorId: adminId, action: 'member.admin_assign', targetType: 'member', targetId: id,
      payload: { toGymId: dto.gymId, fromGymId: member.currentGymId, reason: dto.reason, admin_override: true },
    });
    return { ok: true };
  }

  async adminRelease(id: string, adminId: string, reason?: string) {
    const member = await this.prisma.member.findUnique({ where: { id } });
    if (!member) throw new NotFoundException('Member not found.');
    if (!member.currentGymId) throw new BadRequestException('Member is not currently assigned to any gym.');
    return this.releaseFromGym(id, member.currentGymId, 'admin', adminId, reason);
  }

  // ── Consent-based transfer acceptance (member accepted their own move) ──
  async applyConsentTransfer(memberId: string, toGymId: string) {
    return this.applyTransfer(memberId, toGymId, 'member_accepted_transfer');
  }

  // ── Shared mechanics for any non-override transfer: member-accepted
  // (branch-initiated request) or branch-accepted (admin-initiated
  // request). Both close the old MemberGymHistory row and open a new
  // one the same way — only the `reason` and who's driving differ. The
  // one true "bypasses everything" path stays adminAssign() above.
  async applyTransfer(memberId: string, toGymId: string, reason: string) {
    const [member, targetGym] = await Promise.all([
      this.prisma.member.findUnique({ where: { id: memberId } }),
      this.prisma.gym.findUnique({ where: { id: toGymId } }),
    ]);
    if (!member) throw new NotFoundException('Member not found.');
    if (!targetGym || targetGym.status !== 'active') throw new BadRequestException('Target gym is not available.');

    const memberCount = await this.prisma.member.count({ where: { currentGymId: toGymId } });
    if (memberCount >= targetGym.memberLimit) {
      throw new AppException('MEMBER_LIMIT_REACHED', `Target gym is at its member cap (${targetGym.memberLimit}).`, 400);
    }

    await this.prisma.$transaction(async (tx) => {
      if (member.currentGymId) {
        await tx.memberGymHistory.updateMany({
          where: { memberId, gymId: member.currentGymId, leftAt: null },
          data: { leftAt: new Date(), releasedByType: 'branch', releasedById: undefined, reason },
        });
      }
      await tx.memberGymHistory.create({ data: { memberId, gymId: toGymId, joinedAt: new Date() } });
      await tx.member.update({ where: { id: memberId }, data: { currentGymId: toGymId } });
    });

    await this.auditLog.record({
      actorType: 'member', actorId: memberId, action: 'member.transfer_accepted', targetType: 'member', targetId: memberId,
      payload: { toGymId, fromGymId: member.currentGymId, reason, admin_override: false },
    });
  }

  // ── PIN management ───────────────────────────────────────────────────
  /** Staff/admin-triggered reset — new PIN delivered once, exactly like at creation. */
  async resetPin(id: string, actorType: 'staff' | 'admin', actorId: string) {
    const member = await this.prisma.member.findUnique({ where: { id } });
    if (!member) throw new NotFoundException('Member not found.');
    if (member.isAnonymized) throw new BadRequestException('This member account has been closed.');
    const plainPin = generatePin();
    const pinHash = await hashSecret(plainPin);
    await this.prisma.member.update({ where: { id }, data: { pinHash, failedPinAttempts: 0, lockedUntil: null } });
    await this.auditLog.record({ actorType, actorId, action: 'member.pin_reset', targetType: 'member', targetId: id });
    if (member.phone) {
      await this.notifications.notify({
        recipientType: 'member', recipientId: id, type: 'pin_reset', body: `Your new UV Active PIN is ${plainPin}.`,
        channel: 'sms', recipientAddress: member.phone,
      });
    }
    return { ok: true, plainPin };
  }

  /** Self-service change from inside the Member App — requires the current PIN. */
  async changeOwnPin(memberId: string, currentPin: string, newPin: string) {
    const member = await this.prisma.member.findUnique({ where: { id: memberId } });
    if (!member || !member.pinHash) throw new NotFoundException('Member not found.');
    const ok = await verifySecret(member.pinHash, currentPin);
    if (!ok) throw new ForbiddenException('Current PIN is incorrect.');
    const pinHash = await hashSecret(newPin);
    await this.prisma.member.update({ where: { id: memberId }, data: { pinHash } });
    await this.auditLog.record({ actorType: 'member', actorId: memberId, action: 'member.pin_change', targetType: 'member', targetId: memberId });
    return { ok: true };
  }

  /**
   * Member-initiated PIN recovery via OTP (spec §4.1) — distinct from
   * the staff-triggered reset above. If the member can't receive the
   * OTP at all (lost phone number access etc.), that's a hard stop:
   * recovery must go through Branch Portal / resetPin() instead. This
   * flow never accepts a member-chosen PIN without a valid OTP first.
   */
  async requestPinResetOtp(memberCode: string): Promise<void> {
    const member = await this.prisma.member.findUnique({ where: { memberCode } });
    if (!member || member.isAnonymized) return; // don't reveal whether the code exists
    const otp = String(randomInt(0, 1_000_000)).padStart(6, '0');
    const otpHash = await hashSecret(otp);
    await this.prisma.memberPinReset.create({
      data: { memberId: member.id, otpHash, expiresAt: new Date(Date.now() + OTP_TTL_MINUTES * 60 * 1000) },
    });
    if (member.phone) {
      await this.notifications.notify({
        recipientType: 'member', recipientId: member.id, type: 'pin_reset_otp',
        body: `Your UV Active PIN reset code is ${otp}. It expires in ${OTP_TTL_MINUTES} minutes.`,
        channel: 'sms', recipientAddress: member.phone,
      });
    }
    if (member.email) {
      await this.notifications.notify({
        recipientType: 'member', recipientId: member.id, type: 'pin_reset_otp', title: 'Your UV Active PIN reset code',
        body: `Your code is ${otp}. It expires in ${OTP_TTL_MINUTES} minutes.`,
        channel: 'email', recipientAddress: member.email,
      });
    }
  }

  async confirmPinResetOtp(memberCode: string, otp: string, newPin: string): Promise<void> {
    const member = await this.prisma.member.findUnique({ where: { memberCode } });
    if (!member) throw new UnauthorizedException('Invalid code.');

    const candidates = await this.prisma.memberPinReset.findMany({
      where: { memberId: member.id, usedAt: null, expiresAt: { gt: new Date() } },
      orderBy: { createdAt: 'desc' },
      take: 5,
    });
    let matched: (typeof candidates)[number] | null = null;
    for (const c of candidates) {
      if (await verifySecret(c.otpHash, otp)) { matched = c; break; }
    }
    if (!matched) throw new UnauthorizedException('Invalid or expired code.');

    const pinHash = await hashSecret(newPin);
    await this.prisma.$transaction([
      this.prisma.memberPinReset.update({ where: { id: matched.id }, data: { usedAt: new Date() } }),
      this.prisma.member.update({ where: { id: member.id }, data: { pinHash, failedPinAttempts: 0, lockedUntil: null } }),
    ]);
    await this.auditLog.record({ actorType: 'member', actorId: member.id, action: 'member.pin_reset_self_service', targetType: 'member', targetId: member.id });
  }

  // ── Anonymization (spec §9) ──────────────────────────────────────────
  /**
   * Resolves the retain-forever vs. erasure-request conflict as
   * anonymize-on-request, never hard-delete. Overwrites PII, clears the
   * PIN (login disabled — effective account closure), but retains
   * member_code and all history/session rows so other members' data and
   * the gym's own records stay intact. Flagged as an engineering
   * default pending legal counsel confirmation, not a legal opinion.
   */
  async anonymize(id: string, adminId: string) {
    const member = await this.prisma.member.findUnique({ where: { id } });
    if (!member) throw new NotFoundException('Member not found.');
    if (member.isAnonymized) return { ok: true, alreadyAnonymized: true };

    await this.prisma.$transaction(async (tx) => {
      await tx.member.update({
        where: { id },
        data: {
          name: 'Anonymized Member', phone: null, email: null, photoUrl: null, dob: null,
          pinHash: null, isAnonymized: true, anonymizedAt: new Date(), currentGymId: null,
        },
      });
      if (member.currentGymId) {
        await tx.memberGymHistory.updateMany({
          where: { memberId: id, gymId: member.currentGymId, leftAt: null },
          data: { leftAt: new Date(), releasedByType: 'admin', releasedById: adminId, reason: 'anonymization' },
        });
      }
      await tx.refreshToken.updateMany({ where: { memberId: id, revokedAt: null }, data: { revokedAt: new Date() } });
    });

    // Distinct audit_log entry type from a normal profile edit, per spec.
    await this.auditLog.record({ actorType: 'admin', actorId: adminId, action: 'member.anonymize', targetType: 'member', targetId: id });
    return { ok: true };
  }

  // ── Hard delete (Admin Panel) ────────────────────────────────────────
  /**
   * True, irreversible row deletion — distinct from anonymize() above.
   * anonymize() is the default path for a real member's data-erasure
   * request (keeps member_code + session history intact for other
   * members' data integrity, spec §9). This is for the "created this
   * by mistake" / test-record case where nothing about the row should
   * persist at all. Restricted to super_admin, audited BEFORE the row
   * (and its children) are gone rather than after.
   */
  async delete(id: string, adminId: string) {
    const member = await this.prisma.member.findUnique({ where: { id } });
    if (!member) throw new NotFoundException('Member not found.');

    await this.auditLog.record({
      actorType: 'admin', actorId: adminId, action: 'member.delete', targetType: 'member', targetId: id,
      payload: { memberCode: member.memberCode, name: member.name },
    });

    await this.prisma.$transaction(async (tx) => {
      const sessionMembers = await tx.sessionMember.findMany({ where: { memberId: id }, select: { id: true } });
      const sessionMemberIds = sessionMembers.map((sm) => sm.id);
      if (sessionMemberIds.length > 0) {
        await tx.sensorReading.deleteMany({ where: { sessionMemberId: { in: sessionMemberIds } } });
        await tx.sessionMember.deleteMany({ where: { id: { in: sessionMemberIds } } });
      }
      await tx.memberPinReset.deleteMany({ where: { memberId: id } });
      await tx.refreshToken.deleteMany({ where: { memberId: id } });
      await tx.transferRequest.deleteMany({ where: { memberId: id } });
      await tx.consent.deleteMany({ where: { memberId: id } });
      await tx.memberGymHistory.deleteMany({ where: { memberId: id } });
      await tx.member.delete({ where: { id } });
    });

    return { ok: true };
  }

  // ── Member App self-service (bio only) ───────────────────────────────
  /**
   * Deliberately narrower than UpdateMemberDto (which staff use and
   * which includes name/email/phone). Identity fields stay staff/admin-
   * only — a member can correct their own height/weight/age/sex/resting
   * HR (used for zone/calorie/EPOC math) but can't rename themselves or
   * change the email/phone their account is tied to from the app.
   */
  async updateOwnBio(memberId: string, dto: MemberSelfUpdateDto) {
    const member = await this.prisma.member.findUnique({ where: { id: memberId } });
    if (!member) throw new NotFoundException('Member not found.');
    const updated = await this.prisma.member.update({
      where: { id: memberId },
      data: {
        sex: dto.sex,
        ageYears: dto.ageYears,
        heightCm: dto.heightCm,
        weightKg: dto.weightKg,
        restingHr: dto.restingHr,
        photoUrl: dto.photoUrl,
      },
    });
    await this.auditLog.record({ actorType: 'member', actorId: memberId, action: 'member.self_update_bio', targetType: 'member', targetId: memberId });
    return updated;
  }

  private publicShape(m: { id: string; memberCode: string; name: string; phone: string | null; email: string | null; currentGymId: string | null }) {
    return { id: m.id, memberCode: m.memberCode, name: m.name, phone: m.phone, email: m.email, currentGymId: m.currentGymId };
  }
}
