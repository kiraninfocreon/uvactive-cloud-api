import { Body, Controller, Delete, Get, Param, Patch, Post, Query, Req } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Request } from 'express';
import { Auth, CurrentUser, AuthenticatedUser } from '../common/decorators/auth.decorator';
import { MembersService } from './members.service';
import { NotificationsService } from '../notifications/notifications.service';
import { AdminsService } from '../admins/admins.service';
import { AdminRegisterMemberDto, RegisterMemberDto, UpdateMemberDto, ReleaseMemberDto, AdminAssignMemberDto, ChangePinDto, AnonymizeMemberDto, MemberSelfUpdateDto, SetPushTokenDto } from './members.dto';
// ── Branch Portal / Trainer App routes — staff realm, scoped to own gym ──
@ApiTags('branch/members')
@Controller('branch/members')
export class BranchMembersController {
  constructor(private readonly members: MembersService) {}

  @Auth('staff', ['branch_manager'])
  @Post()
  register(@Body() dto: RegisterMemberDto, @CurrentUser() user: AuthenticatedUser, @Req() req: Request) {
    return this.members.registerByBranch(user.gymId!, dto, user.sub, req.ip || 'unknown');
  }

  @Auth('staff', ['branch_manager', 'trainer'])
  @Get()
  roster(@CurrentUser() user: AuthenticatedUser) {
    return this.members.listForGym(user.gymId!);
  }

  @Auth('staff', ['branch_manager', 'trainer'])
  @Get('search')
  search(@Query('code') code: string) {
    return this.members.searchByCode(code);
  }

  @Auth('staff', ['branch_manager', 'trainer'])
  @Get(':id/profile')
  profile(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.members.getProfileForBranch(id, user.gymId!);
  }

  @Auth('staff', ['branch_manager'])
  @Patch(':id')
  update(@Param('id') id: string, @Body() dto: UpdateMemberDto, @CurrentUser() user: AuthenticatedUser) {
    return this.members.updateProfile(id, dto, user.gymId!);
  }

  @Auth('staff', ['branch_manager'])
  @Post(':id/release')
  release(@Param('id') id: string, @Body() dto: ReleaseMemberDto, @CurrentUser() user: AuthenticatedUser) {
    return this.members.releaseFromGym(id, user.gymId!, 'staff', user.sub, dto.reason);
  }

  @Auth('staff', ['branch_manager'])
  @Post(':id/reset-pin')
  resetPin(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.members.resetPin(id, 'staff', user.sub);
  }
}

// ── Admin Panel routes — admin realm, cross-branch oversight + override ──
@ApiTags('admin/members')
@Controller('admin/members')
@Auth('admin')
export class AdminMembersController {
  constructor(private readonly members: MembersService, private readonly admins: AdminsService) {}

  @Get()
  listAll(@Query('skip') skip?: string, @Query('take') take?: string) {
    return this.members.listAll({ skip: skip ? +skip : undefined, take: take ? +take : undefined });
  }

  // Creates the member unassigned to any gym — placement happens via
  // the transfer-request flow, never a direct assign at creation time.
  @Post()
  register(@Body() dto: AdminRegisterMemberDto, @CurrentUser() user: AuthenticatedUser, @Req() req: Request) {
    return this.members.registerByAdmin(dto, user.sub, req.ip || 'unknown');
  }

  @Get('search')
  search(@Query('code') code: string) {
    return this.members.searchByCode(code);
  }

  @Get(':id')
  get(@Param('id') id: string) {
    return this.members.getFullDetail(id);
  }

  // Bypasses member consent AND the branch's accept/decline entirely —
  // this is the break-glass override, deliberately NOT what the Admin
  // Panel UI uses for normal placement (that's the transfer-request
  // flow — see TransferRequestsService.createFromAdmin). Restricted to
  // super_admin: a support admin routing around "branch has to accept
  // it" via a direct API call would defeat the entire point of that
  // requirement. Tagged admin_override:true in the audit log either way.
  @Auth('admin', ['super_admin'])
  @Post(':id/assign')
  assign(@Param('id') id: string, @Body() dto: AdminAssignMemberDto, @CurrentUser() user: AuthenticatedUser) {
    return this.members.adminAssign(id, dto, user.sub);
  }

  @Post(':id/release')
  release(@Param('id') id: string, @Body() dto: ReleaseMemberDto, @CurrentUser() user: AuthenticatedUser) {
    return this.members.adminRelease(id, user.sub, dto.reason);
  }

  @Post(':id/reset-pin')
  resetPin(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.members.resetPin(id, 'admin', user.sub);
  }

  // super_admin-level, one-way, high-consequence — requires the acting
  // admin to re-enter their own password before it proceeds (spec §9).
  @Auth('admin', ['super_admin'])
  @Post(':id/anonymize')
  async anonymize(@Param('id') id: string, @Body() dto: AnonymizeMemberDto, @CurrentUser() user: AuthenticatedUser) {
    await this.admins.verifyOwnPassword(user.sub, dto.adminPassword);
    return this.members.anonymize(id, user.sub);
  }

  // True hard delete — see MembersService.delete for why this is kept
  // separate from anonymize. super_admin only, same posture as anonymize.
  @Auth('admin', ['super_admin'])
  @Delete(':id')
  delete(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.members.delete(id, user.sub);
  }
}

// ── Member App self-service routes — member realm ─────────────────────
@ApiTags('member')
@Controller('member')
@Auth('member')
export class MemberSelfController {
  constructor(
    private readonly members: MembersService,
    private readonly notifications: NotificationsService,
  ) {}

  @Get('me')
  me(@CurrentUser() user: AuthenticatedUser) {
    return this.members.getFullDetail(user.sub);
  }

  @Post('change-pin')
  changePin(@Body() dto: ChangePinDto, @CurrentUser() user: AuthenticatedUser) {
    return this.members.changeOwnPin(user.sub, dto.currentPin, dto.newPin);
  }

  // Settings screen "edit details" — bio fields only (see
  // MemberSelfUpdateDto). Name/phone/email are read-only here.
  @Patch('me')
  updateBio(@Body() dto: MemberSelfUpdateDto, @CurrentUser() user: AuthenticatedUser) {
    return this.members.updateOwnBio(user.sub, dto);
  }

  // Called right after login (and whenever Expo hands the app a new
  // token — they rotate) so notify() can reach this device with a
  // real system push, not just the in-app bell. Body: { token: string
  // | null } — null clears it (logout / permission revoked).
  @Post('push-token')
  setPushToken(@Body() dto: SetPushTokenDto, @CurrentUser() user: AuthenticatedUser) {
    return this.notifications.setPushToken('member', user.sub, dto.token);
  }
}
