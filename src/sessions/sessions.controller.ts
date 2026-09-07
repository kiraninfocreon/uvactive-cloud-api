import { Body, Controller, Delete, Get, Param, Post, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Auth, CurrentUser, AuthenticatedUser } from '../common/decorators/auth.decorator';
import { SessionsService } from './sessions.service';
import { CreateSessionDto, EnrollMemberDto, EndSessionDto, CancelSessionDto, SetAttendanceDto, IngestSensorReadingsDto } from './sessions.dto';

// ── Trainer App — create/run/end sessions ───────────────────────────
@ApiTags('trainer/sessions')
@Controller('trainer/sessions')
@Auth('staff', ['trainer', 'branch_manager'])
export class TrainerSessionsController {
  constructor(private readonly sessions: SessionsService) {}

  @Post()
  create(@Body() dto: CreateSessionDto, @CurrentUser() user: AuthenticatedUser) {
    return this.sessions.create(user.gymId!, user.sub, dto);
  }

  @Get()
  listMine(@CurrentUser() user: AuthenticatedUser) {
    return this.sessions.listForTrainer(user.sub);
  }

  @Get(':id')
  get(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser) {
    // Gym-scoped: a trainer can only read sessions at their own branch
    // (security review — cross-branch session IDOR fix).
    return this.sessions.getById(id, user.gymId);
  }

  // Leaderboard → member drill-down graph (History tab: session →
  // leaderboard → tap a member → SessionAthleteDetailScreen /
  // AthleteDetailScreen's session-drilldown mode). Mirrors the Branch
  // Portal / Admin Panel's identical route below — this was missing
  // from the Trainer App's own controller, so sessionsApi.athleteTicks()
  // 404'd for every trainer viewing a member's per-session BPM curve /
  // zone distribution here (synced sessions with no local SQLite ticks
  // had nothing to fall back to as a result).
  @Get(':id/athlete/:memberId/ticks')
  athleteTicks(@Param('id') id: string, @Param('memberId') memberId: string, @CurrentUser() user: AuthenticatedUser) {
    return this.sessions.getAthleteTicks(id, memberId, user.gymId!);
  }

  @Post(':id/members')
  enroll(@Param('id') id: string, @Body() dto: EnrollMemberDto, @CurrentUser() user: AuthenticatedUser) {
    return this.sessions.enrollMember(id, dto.memberId, 'trainer', user.gymId);
  }

  @Delete(':id/members/:memberId')
  unenroll(@Param('id') id: string, @Param('memberId') memberId: string, @CurrentUser() user: AuthenticatedUser) {
    return this.sessions.removeMember(id, memberId, user.gymId);
  }

  @Post(':id/attendance')
  setAttendance(@Param('id') id: string, @Body() dto: SetAttendanceDto, @CurrentUser() user: AuthenticatedUser) {
    return this.sessions.setAttendance(id, dto.memberId, dto.attendance, user.sub);
  }

  @Post(':id/start')
  start(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.sessions.start(id, user.sub);
  }

  @Post(':id/end')
  end(@Param('id') id: string, @Body() dto: EndSessionDto, @CurrentUser() user: AuthenticatedUser) {
    return this.sessions.end(id, dto, user.sub);
  }

  @Post(':id/readings')
  ingestReadings(@Param('id') id: string, @Body() dto: IngestSensorReadingsDto, @CurrentUser() user: AuthenticatedUser) {
    return this.sessions.ingestReadings(id, dto.readings, user.sub);
  }

  @Post(':id/cancel')
  cancel(@Param('id') id: string, @Body() dto: CancelSessionDto, @CurrentUser() user: AuthenticatedUser) {
    return this.sessions.cancel(id, dto.reason, 'trainer', user.sub, user.gymId);
  }

  // Recalculate button — a trainer viewing their own past session
  // history where Sweat/Recovery/EPOC/Max %HR read 0 can force a
  // recompute from the raw sensor log without waiting for a branch
  // manager or admin to do it.
  @Post(':id/recalculate')
  recalculateSession(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.sessions.recalculateSession(id, user.gymId);
  }

  @Post(':id/members/:memberId/recalculate')
  recalculateMember(@Param('id') id: string, @Param('memberId') memberId: string, @CurrentUser() user: AuthenticatedUser) {
    return this.sessions.recalculateMember(id, memberId, user.gymId);
  }
}

// ── Branch Portal — mirrors trainer scheduling for a front-desk manager ──
@ApiTags('branch/sessions')
@Controller('branch/sessions')
@Auth('staff', ['branch_manager'])
export class BranchSessionsController {
  constructor(private readonly sessions: SessionsService) {}

  @Post()
  create(@Body() dto: CreateSessionDto, @CurrentUser() user: AuthenticatedUser) {
    return this.sessions.create(user.gymId!, user.sub, dto);
  }

  @Get()
  list(@CurrentUser() user: AuthenticatedUser, @Query('needsReassignment') needsReassignment?: string) {
    return this.sessions.listForGym(user.gymId!, needsReassignment === undefined ? undefined : needsReassignment === 'true');
  }

  @Get(':id')
  get(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser) {
    // Gym-scoped: a branch manager can only read sessions at their own
    // branch (security review — cross-branch session IDOR fix).
    return this.sessions.getById(id, user.gymId);
  }

  @Get(':id/athlete/:memberId/ticks')
  athleteTicks(@Param('id') id: string, @Param('memberId') memberId: string, @CurrentUser() user: AuthenticatedUser) {
    return this.sessions.getAthleteTicks(id, memberId, user.gymId!);
  }

  @Post(':id/members')
  enroll(@Param('id') id: string, @Body() dto: EnrollMemberDto, @CurrentUser() user: AuthenticatedUser) {
    return this.sessions.enrollMember(id, dto.memberId, 'branch', user.gymId);
  }

  @Delete(':id/members/:memberId')
  unenroll(@Param('id') id: string, @Param('memberId') memberId: string, @CurrentUser() user: AuthenticatedUser) {
    return this.sessions.removeMember(id, memberId, user.gymId);
  }

  @Post(':id/cancel')
  cancel(@Param('id') id: string, @Body() dto: CancelSessionDto, @CurrentUser() user: AuthenticatedUser) {
    return this.sessions.cancel(id, dto.reason, 'branch', user.sub, user.gymId);
  }

  // Resolves a needs_reassignment flag by moving the session to a
  // different active trainer at the same branch (spec §8, step 3).
  @Post(':id/reassign/:trainerId')
  reassign(@Param('id') id: string, @Param('trainerId') trainerId: string, @CurrentUser() user: AuthenticatedUser) {
    return this.sessions.reassignTrainer(id, trainerId, user.gymId!);
  }

  // Recalculate button — Branch Portal session/member detail view.
  // Rebuilds Sweat/Recovery/EPOC/Max %HR (and re-ranks the leaderboard)
  // from the stored sensor log for every member in this session.
  @Post(':id/recalculate')
  recalculateSession(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.sessions.recalculateSession(id, user.gymId!);
  }

  @Post(':id/members/:memberId/recalculate')
  recalculateMember(@Param('id') id: string, @Param('memberId') memberId: string, @CurrentUser() user: AuthenticatedUser) {
    return this.sessions.recalculateMember(id, memberId, user.gymId!);
  }

  // "Recompute All Results" — sweeps every completed session at this
  // branch with a missing rich field, recomputes from readings where
  // present, guarantees real zeros where there's no sensor log at
  // all, re-ranks every touched session. One click instead of
  // session-by-session.
  @Post('backfill-results')
  backfillResults(@CurrentUser() user: AuthenticatedUser) {
    return this.sessions.backfillResults(user.gymId!, 5000);
  }
}

// ── Member App — own history + self-booking + self-cancel ────────────
@ApiTags('member/sessions')
@Controller('member/sessions')
@Auth('member')
export class MemberSessionsController {
  constructor(private readonly sessions: SessionsService) {}

  @Get()
  mine(@CurrentUser() user: AuthenticatedUser) {
    return this.sessions.listForMember(user.sub);
  }

  // Book-a-Session screen: every upcoming session at the member's own
  // gym they can still tap to book (must come before ':id' below so
  // "available" isn't parsed as a session id).
  @Get('available')
  available(@CurrentUser() user: AuthenticatedUser) {
    return this.sessions.listAvailableForMember(user.sub);
  }

  // Workout screen: tap a calendar date -> this session's detail
  // (avg HR, peak HR, calories, zone minutes, score).
  @Get(':id')
  get(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.sessions.getForMember(id, user.sub);
  }

  // Powers the per-session BPM graph on the workout detail screen.
  @Get(':id/ticks')
  ticks(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.sessions.getMemberTicks(id, user.sub);
  }

  @Post(':id/book')
  book(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.sessions.selfBook(id, user.sub);
  }

  @Delete(':id/booking')
  cancelBooking(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.sessions.memberSelfCancel(id, user.sub);
  }

  @Get(':id/confirm')
  confirmEnd(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.sessions.endForMember(user.sub, id);
  }
}

// ── Admin Panel — global oversight, read-only (admin doesn't schedule) ──
@ApiTags('admin/sessions')
@Controller('admin/sessions')
@Auth('admin')
export class AdminSessionsController {
  constructor(private readonly sessions: SessionsService) {}

  @Get()
  listAll(@Query('skip') skip?: string, @Query('take') take?: string) {
    return this.sessions.listAll({ skip: skip ? +skip : undefined, take: take ? +take : undefined });
  }

  @Get(':id')
  get(@Param('id') id: string) {
    return this.sessions.getById(id);
  }

  // Same leaderboard → member drill-down as the Branch Portal, but
  // global (no gym scope) for admin oversight.
  @Get(':id/athlete/:memberId/ticks')
  athleteTicks(@Param('id') id: string, @Param('memberId') memberId: string) {
    return this.sessions.getAthleteTicks(id, memberId);
  }

  // Recalculate button — Admin Panel session/member detail view.
  // Global scope: no gym restriction, admin can fix any branch's data.
  @Post(':id/recalculate')
  recalculateSession(@Param('id') id: string) {
    return this.sessions.recalculateSession(id);
  }

  @Post(':id/members/:memberId/recalculate')
  recalculateMember(@Param('id') id: string, @Param('memberId') memberId: string) {
    return this.sessions.recalculateMember(id, memberId);
  }

  // "Recompute All Results" — the Admin Panel Sessions page's button
  // (already built client-side, this was the missing backend route).
  // Sweeps EVERY completed session platform-wide with a missing rich
  // field, recomputes from readings where present, guarantees real
  // zeros where a member has no sensor log at all, re-ranks every
  // touched session. gymId narrows it to one branch if provided.
  @Post('backfill-results')
  backfillResults(@Query('gymId') gymId?: string) {
    return this.sessions.backfillResults(gymId, 5000);
  }
}
