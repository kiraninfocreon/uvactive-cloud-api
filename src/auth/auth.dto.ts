import { IsIn, IsOptional, IsString, Length, MinLength } from 'class-validator';

export class MemberLoginDto {
  @IsString() memberCode!: string;
  @IsString() @Length(6, 6) pin!: string;
  @IsOptional() @IsString() deviceId?: string;
}

// Web/portal alternative to memberCode+PIN — same account, different
// first factor. memberCode+PIN stays the canonical kiosk/QR path.
export class MemberEmailLoginDto {
  @IsString() email!: string;
  @IsString() password!: string;
  @IsOptional() @IsString() deviceId?: string;
}

export class StaffLoginDto {
  @IsString() email!: string;
  @IsString() password!: string;
  // 2FA is mandatory for the staff realm (branch portal), same as
  // admin: first request returns totpRequired/setupRequired, second
  // request (this one, resubmitted with a code) completes login.
  @IsOptional() @IsString() @Length(6, 6) totp?: string;
  @IsOptional() @IsString() backupCode?: string;
  @IsOptional() @IsString() deviceId?: string;
}

export class StaffTotpSetupDto {
  @IsString() setupToken!: string;
}

export class StaffTotpConfirmDto {
  @IsString() setupToken!: string;
  @IsString() @Length(6, 6) code!: string;
}

// Google Identity Services returns a signed ID token to the frontend;
// the frontend forwards it here rather than the app handling any
// OAuth redirect/secret itself. The token is verified server-side
// against Google's public keys (see AuthService.staffGoogleLogin).
// Google can only be linked to an email that ALREADY has a staff
// account — it is never a way to create one.
export class StaffGoogleLoginDto {
  @IsString() idToken!: string;
  @IsOptional() @IsString() @Length(6, 6) totp?: string;
  @IsOptional() @IsString() backupCode?: string;
  @IsOptional() @IsString() deviceId?: string;
}

export class AdminLoginDto {
  @IsString() email!: string;
  @IsString() password!: string;
  @IsOptional() @IsString() @Length(6, 6) totp?: string;
  @IsOptional() @IsString() backupCode?: string;
  @IsOptional() @IsString() deviceId?: string;
}

export class AdminTotpSetupDto {
  @IsString() setupToken!: string;
}

export class AdminTotpConfirmDto {
  @IsString() setupToken!: string;
  @IsString() @Length(6, 6) code!: string;
}

export class RefreshDto {
  @IsIn(['member', 'staff', 'admin']) realm!: 'member' | 'staff' | 'admin';
  @IsString() refreshToken!: string;
}

export class LogoutDto {
  @IsIn(['member', 'staff', 'admin']) realm!: 'member' | 'staff' | 'admin';
  @IsString() refreshToken!: string;
}

// ── Member PIN self-recovery (OTP-based, distinct from staff-triggered reset) ──
export class MemberPinResetRequestDto {
  @IsString() memberCode!: string;
}

export class MemberPinResetConfirmDto {
  @IsString() memberCode!: string;
  @IsString() @Length(6, 6) otp!: string;
  @IsString() @Length(6, 6) newPin!: string;
}

// ── Staff / Admin password recovery — OTP-based, same shape as member
// PIN recovery above. Replaces the earlier deep-link-token design: a
// 6-digit code the person types directly into the portal is far
// easier to build a real UI for than a token embedded in an email
// link, and keeps every "forgot password" flow in this codebase
// consistent (member PIN, staff password, admin password all OTP).
export class ForgotPasswordDto {
  @IsString() email!: string;
}

export class ResetPasswordDto {
  @IsString() email!: string;
  @IsString() @Length(6, 6) otp!: string;
  @IsString() @MinLength(8) newPassword!: string;
}

// "Change my own password while logged in" — distinct from the
// logged-out forgot-password/OTP flow above. Same min-length rule,
// kept consistent so a password valid at signup is never later
// rejected as "too short" and vice versa.
export class ChangePasswordDto {
  @IsString() currentPassword!: string;
  @IsString() @MinLength(8) newPassword!: string;
}
