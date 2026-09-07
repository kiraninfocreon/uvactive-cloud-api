import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import { AuditLogService } from '../audit-log/audit-log.service';
import { NotificationsService } from '../notifications/notifications.service';
import { SensorsService } from '../sensors/sensors.service';
import { AppException } from '../common/exceptions/app.exception';
import { CreateSessionDto, EndSessionDto } from './sessions.dto';
import { zoneForBpm } from '../common/hr.util';
import { recalcSessionMember } from './session-recalc.util';
import { buildChartSeries, ChartSeries } from './chart-downsample.util';
import { Prisma } from '@prisma/client';

// How long a completed session's raw sensor_readings rows stick around
// after its chartSeries has been built, before SensorReadingsRetentionJob
// purges them. Long enough to cover a manual Recalculate (which needs
// the raw log) or a support investigation; short enough that storage
// doesn't grow unbounded with normal session volume (see the comment
// on the SensorReading model in schema.prisma for the growth math).
// Fallback only — the live value is config.graphEngine.rawRetentionDays
// (RAW_READING_RETENTION_DAYS env var), read in purgeStaleRawReadings()
// below. Kept exported so anything still importing the old constant
// doesn't break.
export const RAW_READING_RETENTION_DAYS = 14;

@Injectable()
export class SessionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditLog: AuditLogService,
    private readonly notifications: NotificationsService,
    private readonly sensors: SensorsService,
    private readonly config: ConfigService,
  ) {}

  /**
   * Downsamples one session-member's raw sensor_readings log into a
   * compact chartSeries and persists it — the one write path every
   * caller that has just touched the raw log (end(), recalculateMember())
   * goes through, so chartSeries and the raw log never drift apart.
   * No-op (leaves chartSeries as-is) when there are no raw readings —
   * that's a member with no ingested stream, not an error.
   */
  private async rebuildChartSeries(sessionMemberId: string): Promise<ChartSeries | null> {
    const readings = await this.prisma.sensorReading.findMany({
      where: { sessionMemberId },
      select: { ts: true, hr: true },
      orderBy: { ts: 'asc' },
    });
    const series = buildChartSeries(readings, {
      maxGapMs: this.config.get<number>('graphEngine.maxGapMs'),
      minDeltaBpm: this.config.get<number>('graphEngine.minDeltaBpm'),
      maxChartPoints: this.config.get<number>('graphEngine.maxChartPoints'),
    });
    if (series) {
      await this.prisma.sessionMember.update({
        where: { id: sessionMemberId },
        data: { chartSeries: series as unknown as Prisma.InputJsonValue },
      });
    }
    return series;
  }

  async create(gymId: string, creatorId: string, dto: CreateSessionDto) {
    let trainerId = creatorId;
    if (dto.trainerId && dto.trainerId !== creatorId) {
      const assignee = await this.prisma.trainer.findUnique({ where: { id: dto.trainerId } });
      if (!assignee || assignee.gymId !== gymId) {
        throw new NotFoundException('That trainer was not found at this branch.');
      }
      if (assignee.status !== 'active') {
        throw new BadRequestException('Cannot assign a session to a suspended trainer.');
      }
      trainerId = dto.trainerId;
    }

    // Capacity is fully automatic — always the number of physical sensor
    // straps ("sensor slots") registered at this gym, full stop. There is
    // no trainer/branch-set capacity anymore (dto.capacity is ignored
    // outright, whatever a client sends). A gym with zero sensors
    // registered yet falls back to a default rather than blocking session
    // creation outright, since that would strand any branch that hasn't
    // populated its Sensor tab yet.
    const sensorCount = await this.sensors.countForGym(gymId);
    const capacity = sensorCount > 0 ? sensorCount : 30;

    // If the caller (Trainer App) already minted a local id for this
    // session, use it as the row's real id instead of Prisma's default
    // uuid() — see CreateSessionDto.id for why. Falls through to the
    // schema default when omitted (Branch Portal never sends one).
    try {
      const created = await this.prisma.session.create({
        data: {
          ...(dto.id ? { id: dto.id } : {}),
          gymId,
          trainerId,
          name: dto.name,
          capacity,
          scheduledAt: dto.scheduledAt ? new Date(dto.scheduledAt) : undefined,
          scheduledEndAt: dto.scheduledEndAt ? new Date(dto.scheduledEndAt) : undefined,
        },
      });

      // Let every active member at this gym know a new session just went
      // on the schedule, so it shows up as a notification-bell badge on
      // the Member App home screen and they can book a spot. Fire-and
      // -forget-ish (awaited, but failures are swallowed per-member) so a
      // single bad row never fails the session-creation request itself.
      if (created.scheduledAt) {
        const gymMembers = await this.prisma.member.findMany({
          where: { currentGymId: gymId, status: 'active' },
          select: { id: true },
        });
        await Promise.allSettled(
          gymMembers.map((m) =>
            this.notifications.notify({
              recipientType: 'member',
              recipientId: m.id,
              type: 'session_scheduled',
              title: 'New session scheduled',
              body: `"${created.name}" was just scheduled for ${created.scheduledAt!.toLocaleString()}. Tap to book your spot.`,
              data: { sessionId: created.id },
            }),
          ),
        );
      }

      return created;
    } catch (e: any) {
      // A client-supplied id lets the offline sync queue safely retry a
      // create it never got a response for (timeout/app-kill right
      // after the server-side write succeeded). Same row, same
      // trainer/gym → idempotent no-op returning the existing session.
      // A different trainer/gym on the same id is a real conflict, not
      // a retry, and still fails loudly.
      if (e.code === 'P2002' && dto.id) {
        const existing = await this.prisma.session.findUnique({ where: { id: dto.id } });
        if (existing && existing.gymId === gymId && existing.trainerId === trainerId) return existing;
      }
      throw e;
    }
  }

  listForGym(gymId: string, needsReassignment?: boolean) {
    return this.prisma.session.findMany({
      where: { gymId, ...(needsReassignment !== undefined ? { needsReassignment } : {}) },
      orderBy: { scheduledAt: 'desc' },
      include: { trainer: { select: { id: true, name: true } }, _count: { select: { members: true } } },
    });
  }

  listForTrainer(trainerId: string) {
    return this.prisma.session.findMany({ where: { trainerId }, orderBy: { scheduledAt: 'desc' }, include: { _count: { select: { members: true } } } });
  }

  async listAll(params: { skip?: number; take?: number }) {
    const skip = params.skip ?? 0;
    const take = params.take ?? 50;
    const [data, total] = await Promise.all([
      this.prisma.session.findMany({
        skip, take, orderBy: { createdAt: 'desc' },
        include: { gym: { select: { id: true, name: true } }, trainer: { select: { id: true, name: true } } },
      }),
      this.prisma.session.count(),
    ]);
    return { data, meta: { skip, take, total } };
  }

  /**
   * Single-session read. `scopeGymId` is optional: when provided (the
   * Trainer App / Branch Portal paths) it's enforced against the
   * session's own gym so a trainer or branch manager can only ever read
   * sessions at their own branch — trying to guess another branch's
   * session id returns a 404, not the session's trainer + enrolled
   * member names. Omitted for the Admin Panel, which has legitimate
   * global oversight. This is the one read the earlier security review
   * flagged as an IDOR (cross-branch session data leak) — every other
   * getById-style path in this service was already gym-scoped.
   */
  async getById(id: string, scopeGymId?: string) {
    const session = await this.prisma.session.findUnique({
      where: { id },
      include: {
        trainer: { select: { id: true, name: true } },
        members: { include: { member: { select: { id: true, name: true, memberCode: true } } } },
      },
    });
    if (!session) throw new NotFoundException('Session not found.');
    if (scopeGymId && session.gymId !== scopeGymId) throw new NotFoundException('Session not found.');
    return session;
  }

  // Per-second BPM history for one member within one session — powers
  // the leaderboard → member drill-down graph (spec: "click the member
  // to see the member stat on the session"). Scoped to gymId so a
  // branch can only pull ticks for sessions run at their own gym.
  // Per-second BPM history for one member within one session — powers
  // the leaderboard → member drill-down graph. `gymId` is optional so
  // the Admin Panel (global, no gym scope) can reuse the same path;
  // when provided it's enforced against the session's own gym. Each
  // tick carries its HR zone + %MHR (computed from the member's bio
  // with the same formula engine as the Trainer App) so web graphs can
  // color segments by zone.
  async getAthleteTicks(sessionId: string, memberId: string, gymId?: string) {
    const session = await this.prisma.session.findUnique({ where: { id: sessionId } });
    if (!session) throw new NotFoundException('Session not found.');
    if (gymId && session.gymId !== gymId) throw new NotFoundException('Session not found.');

    const sessionMember = await this.prisma.sessionMember.findUnique({
      where: { sessionId_memberId: { sessionId, memberId } },
      include: { member: { select: { ageYears: true, sex: true } } },
    });
    if (!sessionMember) throw new NotFoundException('This member was not enrolled in that session.');

    return { ticks: await this.readTicksFor(sessionMember) };
  }

  /**
   * The single read path behind both getAthleteTicks and getMemberTicks.
   * Reads the ~200-300pt chartSeries column (a small, single-row read)
   * instead of the raw sensor_readings table — that table can hold
   * thousands of rows per member per session and is what made every
   * graph view get more expensive as session volume grew. Falls back
   * to live-downsampling the raw log (and opportunistically persisting
   * the result) only for rows written before chartSeries existed, or a
   * session ended before this went in — a one-time cost per row, not a
   * steady-state one.
   */
  private async readTicksFor(sessionMember: {
    id: string;
    chartSeries: unknown;
    member: { ageYears: number | null; sex: string | null };
  }) {
    let series = sessionMember.chartSeries as ChartSeries | null;
    if (!series) {
      series = await this.rebuildChartSeries(sessionMember.id);
    }
    if (!series) return [];

    return series.t.map((ts, i) => {
      const hr = series!.hr[i];
      const { zone, pctMhr } = zoneForBpm(hr, sessionMember.member.ageYears, sessionMember.member.sex);
      return { ts, bpm: hr, zone, pctMhr: Math.round(pctMhr * 10) / 10 };
    });
  }

  /**
   * The one shared enrollment path referenced by all three client specs
   * (Branch Portal add, Trainer App add, Member App self-book) — spec §7
   * is explicit this must exist as ONE service function. Fixed from an
   * earlier version that only wrapped the count-check in a transaction
   * without a row lock: under Postgres's default READ COMMITTED
   * isolation, two *different* members racing the last open seat could
   * both observe count < capacity and both insert, overshooting
   * capacity — the UNIQUE(session_id, member_id) constraint only
   * catches the SAME member double-booking, not that. `SELECT ... FOR
   * UPDATE` on the parent session row serializes concurrent enrollment
   * attempts for that session, so the second transaction re-checks the
   * count only after the first has committed or rolled back.
   */
  async enrollMember(sessionId: string, memberId: string, enrolledBy: 'branch' | 'trainer' | 'member_self_book', scopeGymId?: string) {
    return this.prisma.$transaction(async (tx) => {
      const locked = await tx.$queryRaw<{ id: string; gym_id: string; capacity: number; status: string; scheduled_at: Date | null }[]>`
        SELECT id, gym_id, capacity, status, scheduled_at FROM sessions WHERE id = ${sessionId} FOR UPDATE
      `;
      if (locked.length === 0) throw new NotFoundException('Session not found.');
      const session = locked[0];

      if (scopeGymId && session.gym_id !== scopeGymId) throw new ForbiddenException('This session belongs to a different branch.');
      if (session.status === 'completed' || session.status === 'cancelled') {
        throw new BadRequestException(`Cannot add a member to a ${session.status} session.`);
      }

      const member = await tx.member.findUnique({ where: { id: memberId } });
      if (!member) throw new NotFoundException('Member not found.');
      if (member.currentGymId !== session.gym_id) {
        throw new ForbiddenException('This member is not assigned to the gym running this session.');
      }

      // One self-booked session per calendar day — a member browsing
      // "Book a Session" and tapping two different slots on the same
      // day is very likely a mis-tap (or a double-tap network retry),
      // and the product intent is one workout slot a day, not a full
      // schedule. Deliberately scoped to member_self_book only: a
      // branch/trainer manually enrolling a member (a makeup class,
      // covering for another trainer's cancelled slot, etc.) is a
      // staff judgement call this restriction shouldn't block.
      if (enrolledBy === 'member_self_book' && session.scheduled_at) {
        const dayStart = new Date(session.scheduled_at);
        dayStart.setHours(0, 0, 0, 0);
        const dayEnd = new Date(dayStart);
        dayEnd.setDate(dayEnd.getDate() + 1);

        const sameDayBooking = await tx.sessionMember.findFirst({
          where: {
            memberId,
            sessionId: { not: sessionId },
            session: { scheduledAt: { gte: dayStart, lt: dayEnd }, status: { not: 'cancelled' } },
          },
          include: { session: { select: { name: true, scheduledAt: true } } },
        });
        if (sameDayBooking) {
          throw new AppException(
            'ALREADY_BOOKED_TODAY',
            `You already have "${sameDayBooking.session.name}" booked on this day — only one session per day can be booked.`,
            409,
          );
        }
      }

      const currentCount = await tx.sessionMember.count({ where: { sessionId } });
      if (currentCount >= session.capacity) {
        throw new AppException('SESSION_FULL', 'This session is at capacity.', 409);
      }

      try {
        return await tx.sessionMember.create({ data: { sessionId, memberId, enrolledBy } });
      } catch (e: any) {
        if (e.code === 'P2002') throw new ConflictException('This member is already enrolled in this session.');
        throw e;
      }
    });
  }

  async removeMember(sessionId: string, memberId: string, scopeGymId?: string) {
    const session = await this.prisma.session.findUnique({ where: { id: sessionId } });
    if (!session) throw new NotFoundException('Session not found.');
    if (scopeGymId && session.gymId !== scopeGymId) throw new ForbiddenException('This session belongs to a different branch.');
    const row = await this.prisma.sessionMember.findUnique({ where: { sessionId_memberId: { sessionId, memberId } } });
    if (!row) throw new NotFoundException('This member is not enrolled in this session.');
    if (row.resultSubmittedAt) throw new BadRequestException('Cannot remove a member who already has results recorded.');
    await this.prisma.sessionMember.delete({ where: { id: row.id } });
    return { ok: true };
  }

  /** Member self-cancel — frees the slot, only while the session hasn't started yet (spec §7). */
  async memberSelfCancel(sessionId: string, memberId: string) {
    const session = await this.prisma.session.findUnique({ where: { id: sessionId } });
    if (!session) throw new NotFoundException('Session not found.');
    if (session.status !== 'scheduled') throw new BadRequestException('Cannot cancel a booking once the session has started.');
    const row = await this.prisma.sessionMember.findUnique({ where: { sessionId_memberId: { sessionId, memberId } } });
    if (!row) throw new NotFoundException('You are not booked into this session.');
    await this.prisma.sessionMember.delete({ where: { id: row.id } });
    return { ok: true };
  }

  async start(sessionId: string, trainerId: string) {
    const session = await this.assertOwnedByTrainer(sessionId, trainerId);
    // Idempotent: the Trainer App's offline outbox can replay this call
    // (app killed after the server applied it but before the response
    // landed). Already-in-progress is "we already did this", not an
    // error — return the row as-is instead of throwing. Any other
    // status (completed/cancelled) is a genuine conflict and still
    // rejected.
    if (session.status === 'in_progress') return session;
    if (session.status !== 'scheduled') throw new BadRequestException(`Cannot start a session that is ${session.status}.`);
    // A scheduled session can never be started before its scheduled
    // time — no upper bound (any time AFTER is fine), just never
    // before. The Trainer App already disables the Start button
    // client-side for this, but that alone doesn't stop a direct API
    // call, a race against a clock that's slightly ahead, or an
    // offline 'session_start' sync event that was queued (by a bug, a
    // clock skew, or a future client build) before the gate applied
    // and only reaches the server later — so this has to be the
    // authoritative check, not just a UI nicety.
    if (session.scheduledAt && new Date() < session.scheduledAt) {
      throw new BadRequestException(
        `This session is scheduled to start at ${session.scheduledAt.toISOString()} — it can't be started early.`,
      );
    }
    return this.prisma.session.update({ where: { id: sessionId }, data: { status: 'in_progress', startedAt: new Date() } });
  }

  /** Set at session start / during the session — trainer marks each enrolled member's attendance (spec §7). */
  async setAttendance(sessionId: string, memberId: string, attendance: 'enrolled' | 'attended' | 'no_show', trainerId: string) {
    await this.assertOwnedByTrainer(sessionId, trainerId);
    const row = await this.prisma.sessionMember.findUnique({ where: { sessionId_memberId: { sessionId, memberId } } });
    if (!row) throw new NotFoundException('This member is not enrolled in this session.');
    return this.prisma.sessionMember.update({ where: { id: row.id }, data: { attendance } });
  }

  /**
   * Idempotent by session_id + member_id (spec §7): a retried upload
   * from a trainer's offline outbox can never double-write results,
   * because this is an upsert keyed on the same UNIQUE(session_id,
   * member_id) constraint enrollment already uses — never a blind
   * insert. Also the receiving side of §13's offline-sync ingestion:
   * rejects a submission for a session never started, or for a member
   * never enrolled in it.
   */
  async end(sessionId: string, dto: EndSessionDto, trainerId: string) {
    const session = await this.assertOwnedByTrainer(sessionId, trainerId);
    if (session.status === 'scheduled') throw new BadRequestException('Cannot end a session that was never started.');

    await this.prisma.$transaction(async (tx) => {
      for (const r of dto.results) {
        const enrolled = await tx.sessionMember.findUnique({ where: { sessionId_memberId: { sessionId, memberId: r.memberId } } });
        if (!enrolled) {
          throw new BadRequestException(`Member ${r.memberId} was never enrolled in this session — cannot submit a result for them.`);
        }
        await tx.sessionMember.update({
          where: { sessionId_memberId: { sessionId, memberId: r.memberId } },
          data: {
            avgHr: r.avgHr, maxHr: r.maxHr, calories: r.calories, zoneMinutes: r.zoneMinutes as any, score: r.score,
            // Rich post-workout summary (spec §7) — sent by the Trainer
            // App's formula engine alongside the core aggregates.
            sweatPoints: r.sweatPoints, recoveryPoints: r.recoveryPoints, recoveryGrade: r.recoveryGrade,
            epocCalories: r.epocCalories, epocHours: r.epocHours, avgPctMhr: r.avgPctMhr, maxPctMhr: r.maxPctMhr,
            finalRank: r.finalRank, consistencyPct: r.consistencyPct,
            resultSubmittedAt: enrolled.resultSubmittedAt ?? new Date(),
            syncedAt: new Date(),
            attendance: enrolled.attendance === 'enrolled' ? 'attended' : enrolled.attendance,
          },
        });
      }
      if (session.status !== 'completed') {
        await tx.session.update({ where: { id: sessionId }, data: { status: 'completed', endedAt: new Date() } });
      }
    });

    // Downsample each member's raw BPM log into chartSeries now, once,
    // while the session is fresh — every later graph view reads that
    // instead of re-aggregating sensor_readings. No-op for a member the
    // Trainer App never streamed live readings for (dto.results only
    // carries the already-computed aggregates, not the raw ticks).
    for (const r of dto.results) {
      const enrolled = await this.prisma.sessionMember.findUnique({ where: { sessionId_memberId: { sessionId, memberId: r.memberId } } });
      if (enrolled) await this.rebuildChartSeries(enrolled.id);
    }

    await this.auditLog.record({ actorType: 'staff', actorId: trainerId, action: 'session.end', targetType: 'session', targetId: sessionId, payload: { resultCount: dto.results.length } });

    for (const r of dto.results) {
      await this.notifications.notify({ recipientType: 'member', recipientId: r.memberId, type: 'result_ready', body: 'Your session results are ready.' });
    }
    return this.getById(sessionId);
  }

  /**
   * Member-facing session-end acknowledgement — returns the completed
   * session's summary for the calling member only, used by the Member App
   * to confirm the workout saved and show a summary card. No side effects,
   * just a read — the real end() is already done by the trainer.
   */
  async endForMember(memberId: string, sessionId: string) {
    const sm = await this.prisma.sessionMember.findUnique({
      where: { sessionId_memberId: { sessionId, memberId } },
      include: { session: true, member: { select: { name: true } } },
    });
    if (!sm) throw new NotFoundException('Session result not found.');
    if (sm.session.status !== 'completed') throw new BadRequestException('This session has not been completed yet.');
    return sm;
  }

  /** Branch or trainer cancels the whole session — notifies every enrolled member (spec §7). */
  async cancel(sessionId: string, reason: string | undefined, actorType: 'trainer' | 'branch' | 'admin', actorId: string, scopeGymId?: string) {
    const session = await this.prisma.session.findUnique({ where: { id: sessionId }, include: { members: true } });
    if (!session) throw new NotFoundException('Session not found.');
    if (scopeGymId && session.gymId !== scopeGymId) throw new ForbiddenException('This session belongs to a different branch.');
    if (session.status === 'completed') throw new BadRequestException('Cannot cancel a completed session.');

    await this.prisma.session.update({
      where: { id: sessionId },
      data: { status: 'cancelled', cancelledReason: reason, cancelledByType: actorType, cancelledById: actorId, needsReassignment: false },
    });
    await this.auditLog.record({ actorType: actorType === 'admin' ? 'admin' : 'staff', actorId, action: 'session.cancel', targetType: 'session', targetId: sessionId, payload: { reason } });

    for (const m of session.members) {
      await this.notifications.notify({
        recipientType: 'member', recipientId: m.memberId, type: 'session_cancelled',
        title: 'Session cancelled', body: reason ? `Your session was cancelled: ${reason}` : 'Your session was cancelled.',
      });
    }
    return { ok: true };
  }

  // ── Member-facing ────────────────────────────────────────────────────
  listForMember(memberId: string) {
    return this.prisma.sessionMember.findMany({
      where: { memberId },
      include: { session: { include: { gym: { select: { name: true } }, trainer: { select: { name: true } } } } },
      orderBy: { enrolledAt: 'desc' },
    });
  }

  /**
   * Member App "Book a Session" list — every future scheduled session at
   * the member's own gym they haven't already booked, newest-scheduled
   * first, with a live open-spots count so the UI can show "Full"
   * without a second round trip. Capacity here is always the gym's
   * sensor-slot count (see create()), never a trainer-picked number.
   */
  async listAvailableForMember(memberId: string) {
    const member = await this.prisma.member.findUnique({ where: { id: memberId } });
    if (!member?.currentGymId) return [];

    const [sessions, myBookings] = await Promise.all([
      this.prisma.session.findMany({
        where: { gymId: member.currentGymId, status: 'scheduled', scheduledAt: { gt: new Date() } },
        orderBy: { scheduledAt: 'asc' },
        include: { trainer: { select: { id: true, name: true } }, _count: { select: { members: true } } },
      }),
      this.prisma.sessionMember.findMany({ where: { memberId }, select: { sessionId: true } }),
    ]);
    const bookedIds = new Set(myBookings.map((b) => b.sessionId));
    return sessions.map((s) => ({
      ...s,
      isBooked: bookedIds.has(s.id),
      spotsOpen: Math.max(0, s.capacity - s._count.members),
    }));
  }

  // Member App workout-detail screen: tap a calendar date -> this one
  // session's own result row (avgHr/maxHr/calories/zoneMinutes/score).
  // EPOC/avg-zone/etc. are derived client-side from zoneMinutes by the
  // same formula-engine the Trainer App uses — nothing new to compute
  // server-side, this just needs to return the raw aggregate.
  async getForMember(sessionId: string, memberId: string) {
    const sessionMember = await this.prisma.sessionMember.findUnique({
      where: { sessionId_memberId: { sessionId, memberId } },
      include: { session: { include: { gym: { select: { name: true } }, trainer: { select: { name: true } } } } },
    });
    if (!sessionMember) throw new NotFoundException('Session not found for this member.');
    return sessionMember;
  }

  // Same BPM-tick drill-down as getAthleteTicks (Branch Portal), but
  // scoped to the calling member's own membership rather than a gymId
  // — a member can only ever pull their own tick history.
  // Same BPM-tick drill-down as getAthleteTicks (Branch Portal), but
  // scoped to the calling member's own membership rather than a gymId
  // — a member can only ever pull their own tick history. Also
  // zone-tags each tick (matching getAthleteTicks) so the Member App's
  // history graph can render the same zone-coloured curve the trainer,
  // branch, and admin apps all show for this session — previously this
  // returned bare {ts, bpm} with no zone, so the Member App's graph was
  // silently flat-coloured even though the data existed everywhere else.
  async getMemberTicks(sessionId: string, memberId: string) {
    const sessionMember = await this.prisma.sessionMember.findUnique({
      where: { sessionId_memberId: { sessionId, memberId } },
      include: { member: { select: { ageYears: true, sex: true } } },
    });
    if (!sessionMember) throw new NotFoundException('Session not found for this member.');

    return { ticks: await this.readTicksFor(sessionMember) };
  }

  async selfBook(sessionId: string, memberId: string) {
    return this.enrollMember(sessionId, memberId, 'member_self_book');
  }

  /**
   * Optional raw HR stream ingestion for a future full BPM graph view
   * (spec §5's `sensor_readings` table) — the Trainer App's BLE layer
   * can batch-upload these during or after a session. Purely additive:
   * the aggregate fields on SessionMember (avgHr/maxHr/zoneMinutes/
   * score) written by end() are always sufficient on their own for
   * scoring, so a trainer app that never calls this endpoint loses
   * nothing but the detailed graph.
   */
  async ingestReadings(sessionId: string, readings: { memberId: string; ts: string; hr: number; rrMs?: number; interpolated?: boolean }[], trainerId: string) {
    await this.assertOwnedByTrainer(sessionId, trainerId);

    // Resolve each memberId to its session_members row up front so a
    // reading for a member never enrolled in this session is rejected
    // outright, same posture as end()'s validation.
    const memberIds = [...new Set(readings.map((r) => r.memberId))];
    const enrolledRows = await this.prisma.sessionMember.findMany({ where: { sessionId, memberId: { in: memberIds } } });
    const bySessionMemberId = new Map(enrolledRows.map((row) => [row.memberId, row.id]));

    const missing = memberIds.filter((id) => !bySessionMemberId.has(id));
    if (missing.length > 0) {
      throw new BadRequestException(`Member(s) not enrolled in this session, cannot record readings: ${missing.join(', ')}`);
    }

    await this.prisma.sensorReading.createMany({
      data: readings.map((r) => ({
        sessionMemberId: bySessionMemberId.get(r.memberId)!,
        ts: new Date(r.ts),
        hr: r.hr,
        rrMs: r.rrMs,
        interpolated: r.interpolated ?? false,
      })),
    });
    return { ok: true, count: readings.length };
  }

  /**
   * Recomputes one session-member's rich post-workout fields (Sweat
   * Points, Recovery Points, EPOC, Max %HR, etc.) from their stored
   * SensorReading log — see session-recalc.util.ts. Fixes rows that
   * synced with these fields null/zero (old client build, a crash
   * before the Trainer App's finalizeSummary ran, or a formula fix
   * that needs re-applying to historical data). Safe to call
   * repeatedly — deterministic given the same readings.
   */
  async recalculateMember(sessionId: string, memberId: string, scopeGymId?: string) {
    const sessionMember = await this.prisma.sessionMember.findUnique({
      where: { sessionId_memberId: { sessionId, memberId } },
      include: { member: true, session: true },
    });
    if (!sessionMember) throw new NotFoundException('This member was not enrolled in that session.');
    if (scopeGymId && sessionMember.session.gymId !== scopeGymId) throw new NotFoundException('Session not found.');

    const readings = await this.prisma.sensorReading.findMany({
      where: { sessionMemberId: sessionMember.id },
      select: { ts: true, hr: true },
    });

    const result = recalcSessionMember(readings, {
      ageYears: sessionMember.member.ageYears,
      sex: sessionMember.member.sex,
      heightCm: sessionMember.member.heightCm,
      weightKg: sessionMember.member.weightKg,
    });

    if (result.readingCount === 0) {
      return { recalculated: false, reason: 'No sensor readings stored for this member in this session.', sessionMemberId: sessionMember.id };
    }

    await this.prisma.sessionMember.update({
      where: { id: sessionMember.id },
      data: {
        avgHr: result.avgHr,
        maxHr: result.maxHr,
        // Never clobber a calorie figure the Trainer App already sent
        // just because bio data is missing for this recompute — only
        // overwrite when we actually derived a fresh value.
        ...(result.calories != null ? { calories: result.calories } : {}),
        zoneMinutes: result.zoneMinutes as any,
        sweatPoints: result.sweatPoints,
        recoveryPoints: result.recoveryPoints,
        recoveryGrade: result.recoveryGrade,
        epocCalories: result.epocCalories,
        epocHours: result.epocHours,
        avgPctMhr: result.avgPctMhr,
        maxPctMhr: result.maxPctMhr,
        score: result.score,
        syncedAt: new Date(),
      },
    });

    // Recalculate reads the raw log anyway — regenerate chartSeries
    // from the same data in the same pass rather than leaving it stale.
    await this.rebuildChartSeries(sessionMember.id);

    return { recalculated: true, sessionMemberId: sessionMember.id, ...result };
  }

  /** Recalculates every enrolled member of one session, then re-ranks the leaderboard by the refreshed UV score — same convention as SessionEngine.endSession(). */
  async recalculateSession(sessionId: string, scopeGymId?: string) {
    const session = await this.prisma.session.findUnique({ where: { id: sessionId } });
    if (!session) throw new NotFoundException('Session not found.');
    if (scopeGymId && session.gymId !== scopeGymId) throw new NotFoundException('Session not found.');

    const members = await this.prisma.sessionMember.findMany({ where: { sessionId }, select: { memberId: true } });
    const results: { memberId: string; recalculated: boolean; score?: number | null }[] = [];
    for (const m of members) {
      const r = await this.recalculateMember(sessionId, m.memberId, scopeGymId);
      results.push({ memberId: m.memberId, recalculated: r.recalculated, score: 'score' in r ? r.score : undefined });
    }

    // Re-rank by refreshed UV score, highest first — mirrors the
    // Trainer App's own end-of-session ranking convention.
    const ranked = await this.prisma.sessionMember.findMany({ where: { sessionId }, orderBy: [{ score: 'desc' }] });
    await this.prisma.$transaction(
      ranked.map((r, i) => this.prisma.sessionMember.update({ where: { id: r.id }, data: { finalRank: r.score != null ? i + 1 : null } })),
    );

    return { sessionId, memberCount: members.length, results };
  }

  /**
   * Bulk backfill — the "Recompute All Results" / "Recalculate All"
   * button on Admin Panel and Branch Portal. Sweeps every completed
   * session (optionally scoped to one gym for a Branch Portal call)
   * whose members are missing a rich post-workout field, and:
   *  - recomputes them from the stored sensor log where one exists
   *    ("updated"), or
   *  - explicitly zeroes the rich fields when NO sensor log exists at
   *    all for that member ("zeroFilled") — a member who was enrolled
   *    but never actually had a sensor reading synced (crashed before
   *    finishing, sensor never connected, pre-dates readings storage)
   *    should read as a real 0/0%, not an indefinite blank "—" that
   *    looks broken forever on every portal.
   * Also re-ranks every touched session's leaderboard by the refreshed
   * UV score. Safe to re-run — deterministic given the same data.
   */
  async backfillResults(scopeGymId?: string, limit = 2000) {
    const candidateMembers = await this.prisma.sessionMember.findMany({
      where: {
        session: { status: 'completed', ...(scopeGymId ? { gymId: scopeGymId } : {}) },
        OR: [{ sweatPoints: null }, { epocCalories: null }, { maxPctMhr: null }, { avgPctMhr: null }, { recoveryPoints: null }],
      },
      select: { id: true, sessionId: true, memberId: true },
      take: limit,
    });

    let updated = 0;
    let zeroFilled = 0;
    const touchedSessions = new Set<string>();

    for (const cm of candidateMembers) {
      try {
        const r = await this.recalculateMember(cm.sessionId, cm.memberId, scopeGymId);
        touchedSessions.add(cm.sessionId);
        if (r.recalculated) {
          updated++;
        } else {
          // No sensor readings at all — guarantee a real zero instead
          // of leaving these fields null forever.
          await this.prisma.sessionMember.update({
            where: { id: cm.id },
            data: {
              sweatPoints: 0, recoveryPoints: 0, recoveryGrade: null,
              epocCalories: 0, epocHours: 0, avgPctMhr: 0, maxPctMhr: 0,
              score: 0,
            },
          });
          zeroFilled++;
        }
      } catch (e) {
        // One corrupt/edge-case member must never abort the whole
        // sweep — skip and keep going, matches the Trainer App's own
        // endSession() posture on a single bad accumulator.
      }
    }

    let sessionsReRanked = 0;
    for (const sessionId of touchedSessions) {
      const ranked = await this.prisma.sessionMember.findMany({ where: { sessionId }, orderBy: [{ score: 'desc' }] });
      await this.prisma.$transaction(
        ranked.map((r, i) => this.prisma.sessionMember.update({ where: { id: r.id }, data: { finalRank: r.score != null ? i + 1 : null } })),
      );
      sessionsReRanked++;
    }

    return { processed: candidateMembers.length, updated, zeroFilled, sessionsReRanked, truncatedAtLimit: candidateMembers.length === limit };
  }

  private async assertOwnedByTrainer(sessionId: string, trainerId: string) {
    const session = await this.prisma.session.findUnique({ where: { id: sessionId } });
    if (!session) throw new NotFoundException('Session not found.');
    if (session.trainerId !== trainerId) throw new ForbiddenException('This session belongs to a different trainer.');
    return session;
  }

  // ── Called by TrainersService on suspend, and by the auto-cancel cron ──
  /** Flags every future scheduled session owned by a newly-suspended trainer (spec §8, step 1-2). */
  async flagSessionsForReassignment(trainerId: string): Promise<number> {
    const result = await this.prisma.session.updateMany({
      where: { trainerId, status: 'scheduled', scheduledAt: { gt: new Date() } },
      data: { needsReassignment: true },
    });
    return result.count;
  }

  /** Fallback path: a flagged session nobody reassigned, now past its start time — auto-cancel + notify (spec §8, step 4). */
  async autoCancelOverdueFlagged(): Promise<number> {
    const overdue = await this.prisma.session.findMany({
      where: { needsReassignment: true, status: 'scheduled', scheduledAt: { lt: new Date() } },
      include: { members: true },
    });
    for (const session of overdue) {
      await this.prisma.session.update({
        where: { id: session.id },
        data: { status: 'cancelled', cancelledReason: 'Trainer suspended, no reassignment made in time', cancelledByType: 'system', needsReassignment: false },
      });
      for (const m of session.members) {
        await this.notifications.notify({
          recipientType: 'member', recipientId: m.memberId, type: 'session_cancelled',
          title: 'Session cancelled', body: 'Your session was cancelled because no trainer was reassigned in time.',
        });
      }
    }
    return overdue.length;
  }

  /**
   * Called on a schedule by SensorReadingsRetentionJob — reclaims the
   * raw sensor_readings storage for completed sessions whose members
   * already have a chartSeries built (so the graph keeps working) and
   * whose session ended more than RAW_READING_RETENTION_DAYS ago.
   * Deliberately member-by-member rather than one giant DELETE: a
   * member whose chartSeries build failed or was never run (e.g. no
   * readings were ever ingested) is simply skipped this pass rather
   * than having its raw log deleted with nothing to fall back on.
   * Returns the number of raw reading rows removed, for logging.
   */
  async purgeStaleRawReadings(): Promise<number> {
    const retentionDays = this.config.get<number>('graphEngine.rawRetentionDays') ?? RAW_READING_RETENTION_DAYS;
    const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);
    const candidates = await this.prisma.sessionMember.findMany({
      where: {
        // chartSeries is only ever written as a real object (never an
        // explicit JSON `null`), so a plain DB NULL is what "not built
        // yet" looks like — Prisma.DbNull, not Prisma.JsonNull, is the
        // correct sentinel to exclude those rows here.
        chartSeries: { not: Prisma.DbNull },
        session: { status: 'completed', endedAt: { lt: cutoff } },
        readings: { some: {} },
      },
      select: { id: true },
    });
    if (candidates.length === 0) return 0;

    const result = await this.prisma.sensorReading.deleteMany({
      where: { sessionMemberId: { in: candidates.map((c) => c.id) } },
    });
    return result.count;
  }

  /** Branch reassigns a flagged session to a different trainer at the same gym. */
  async reassignTrainer(sessionId: string, newTrainerId: string, gymId: string) {
    const session = await this.prisma.session.findUnique({ where: { id: sessionId } });
    if (!session) throw new NotFoundException('Session not found.');
    if (session.gymId !== gymId) throw new ForbiddenException('This session belongs to a different branch.');
    const trainer = await this.prisma.trainer.findUnique({ where: { id: newTrainerId } });
    if (!trainer || trainer.gymId !== gymId || trainer.status !== 'active') {
      throw new BadRequestException('The selected trainer is not an active member of your branch.');
    }
    return this.prisma.session.update({ where: { id: sessionId }, data: { trainerId: newTrainerId, needsReassignment: false } });
  }
}
