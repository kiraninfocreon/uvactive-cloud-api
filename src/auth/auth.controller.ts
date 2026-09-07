import { Body, Controller, Post, Req } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Request } from 'express';
import { AuthService } from './auth.service';
import { Auth, CurrentUser, AuthenticatedUser } from '../common/decorators/auth.decorator';
import {
  MemberLoginDto, MemberEmailLoginDto, StaffLoginDto, StaffTotpSetupDto, StaffTotpConfirmDto, StaffGoogleLoginDto,
  AdminLoginDto, AdminTotpSetupDto, AdminTotpConfirmDto, RefreshDto, LogoutDto,
  MemberPinResetRequestDto, MemberPinResetConfirmDto, ForgotPasswordDto, ResetPasswordDto, ChangePasswordDto,
} from './auth.dto';

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  // ── Member ───────────────────────────────────────────────────────────
  @Post('member/login')
  memberLogin(@Body() dto: MemberLoginDto, @Req() req: Request) {
    return this.auth.memberLogin(dto, req.ip || 'unknown');
  }

  // Web/portal alternative first factor — same member account as
  // member/login, just email+password instead of memberCode+PIN.
  @Post('member/login-email')
  memberEmailLogin(@Body() dto: MemberEmailLoginDto, @Req() req: Request) {
    return this.auth.memberEmailLogin(dto, req.ip || 'unknown');
  }

  @Post('member/pin/reset-request')
  memberPinResetRequest(@Body() dto: MemberPinResetRequestDto) {
    return this.auth.memberPinResetRequest(dto);
  }

  @Post('member/pin/reset-confirm')
  memberPinResetConfirm(@Body() dto: MemberPinResetConfirmDto) {
    return this.auth.memberPinResetConfirm(dto);
  }

  // ── Staff ────────────────────────────────────────────────────────────
  @Post('staff/login')
  staffLogin(@Body() dto: StaffLoginDto, @Req() req: Request) {
    return this.auth.staffLogin(dto, req.ip || 'unknown');
  }

  @Post('staff/google')
  staffGoogleLogin(@Body() dto: StaffGoogleLoginDto, @Req() req: Request) {
    return this.auth.staffGoogleLogin(dto, req.ip || 'unknown');
  }

  @Post('staff/2fa/setup')
  staffTotpSetup(@Body() dto: StaffTotpSetupDto) {
    return this.auth.staffTotpSetup(dto.setupToken);
  }

  @Post('staff/2fa/confirm')
  staffTotpConfirm(@Body() dto: StaffTotpConfirmDto) {
    return this.auth.staffTotpConfirm(dto);
  }

  @Post('staff/forgot-password')
  staffForgotPassword(@Body() dto: ForgotPasswordDto) {
    return this.auth.forgotPassword('staff', dto);
  }

  @Post('staff/reset-password')
  staffResetPassword(@Body() dto: ResetPasswordDto) {
    return this.auth.resetPassword('staff', dto);
  }

  // Authenticated self-service (Branch Portal Settings) — distinct
  // from the logged-out OTP-based reset-password above.
  @Auth('staff', ['branch_manager', 'trainer'])
  @Post('staff/change-password')
  staffChangePassword(@Body() dto: ChangePasswordDto, @CurrentUser() user: AuthenticatedUser) {
    return this.auth.changeOwnPassword('staff', user.sub, dto);
  }

  // ── Admin ────────────────────────────────────────────────────────────
  @Post('admin/login')
  adminLogin(@Body() dto: AdminLoginDto, @Req() req: Request) {
    return this.auth.adminLogin(dto, req.ip || 'unknown');
  }

  @Post('admin/forgot-password')
  adminForgotPassword(@Body() dto: ForgotPasswordDto) {
    return this.auth.forgotPassword('admin', dto);
  }

  @Post('admin/reset-password')
  adminResetPassword(@Body() dto: ResetPasswordDto) {
    return this.auth.resetPassword('admin', dto);
  }

  @Auth('admin')
  @Post('admin/change-password')
  adminChangePassword(@Body() dto: ChangePasswordDto, @CurrentUser() user: AuthenticatedUser) {
    return this.auth.changeOwnPassword('admin', user.sub, dto);
  }

  @Post('admin/2fa/setup')
  adminTotpSetup(@Body() dto: AdminTotpSetupDto) {
    return this.auth.adminTotpSetup(dto.setupToken);
  }

  @Post('admin/2fa/confirm')
  adminTotpConfirm(@Body() dto: AdminTotpConfirmDto) {
    return this.auth.adminTotpConfirm(dto);
  }

  // ── Shared ───────────────────────────────────────────────────────────
  @Post('refresh')
  refresh(@Body() dto: RefreshDto) {
    return this.auth.refresh(dto.realm, dto.refreshToken);
  }

  @Post('logout')
  async logout(@Body() dto: LogoutDto) {
    await this.auth.logout(dto.realm, dto.refreshToken);
    return { ok: true };
  }
}
