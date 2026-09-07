import { BadRequestException, ForbiddenException, Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { authenticator } from 'otplib';
import * as jwt from 'jsonwebtoken';
import { PrismaService } from '../prisma/prisma.service';
import { TokenService } from '../common/utils/token.service';
import { RateLimitService } from '../common/utils/rate-limit.service';
import { hashSecret, verifySecret } from '../common/utils/hash.util';
import { generateBackupCode, generateOtp } from '../common/utils/id-generator';
import { AuditLogService } from '../audit-log/audit-log.service';
import { NotificationsService } from '../notifications/notifications.service';
import { MembersService } from '../members/members.service';
import { AppException } from '../common/exceptions/app.exception';
import {
  MemberLoginDto, MemberEmailLoginDto, StaffLoginDto, StaffTotpConfirmDto, StaffGoogleLoginDto, AdminLoginDto, AdminTotpConfirmDto,
  MemberPinResetRequestDto, MemberPinResetConfirmDto, ForgotPasswordDto, ResetPasswordDto, ChangePasswordDto,
} from './auth.dto';

const LOCKOUT_THRESHOLD = 5;
const LOCKOUT_MINUTES = 15;
const RESET_TOKEN_TTL_MINUTES = 15;

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tokens: TokenService,
    private readonly rateLimit: RateLimitService,
    private readonly auditLog: AuditLogService,
    private readonly notifications: NotificationsService,
    private readonly members: MembersService,
    private readonly config: ConfigService,
  ) {
    authenticator.options = { window: 1 }; // ±30s clock drift tolerance
  }

  // ── Member realm ────────────────────────────────────────────────────
  async memberLogin(dto: MemberLoginDto, ip: string) {
    const idKey = `login:member:id:${dto.memberCode}`;
    const ipKey = `login:member:ip:${ip}`;
    await this.rateLimit.assertNotBlocked([idKey, ipKey]);

    const member = await this.prisma.member.findUnique({ where: { memberCode: dto.memberCode } });
    const fail = async () => {
      await this.rateLimit.recordFailure(idKey);
      await this.rateLimit.recordFailure(ipKey);
      throw new UnauthorizedException('Incorrect member ID or PIN.');
    };

    if (!member || member.isAnonymized || !member.pinHash) return fail();
    if (member.status !== 'active') throw new ForbiddenException('This member account is suspended.');
    if (member.lockedUntil && member.lockedUntil > new Date()) {
      throw new AppException('PIN_LOCKED', 'Too many failed attempts. Try again later.', 401);
    }

    const ok = await verifySecret(member.pinHash, dto.pin);
    if (!ok) {
      const attempts = member.failedPinAttempts + 1;
      await this.prisma.member.update({
        where: { id: member.id },
        data: {
          failedPinAttempts: attempts,
          lockedUntil: attempts >= LOCKOUT_THRESHOLD ? new Date(Date.now() + LOCKOUT_MINUTES * 60 * 1000) : undefined,
        },
      });
      return fail();
    }

    await this.rateLimit.clear(idKey);
    await this.prisma.member.update({ where: { id: member.id }, data: { failedPinAttempts: 0, lockedUntil: null } });

    const accessToken = this.tokens.signAccessToken({ sub: member.id, realm: 'member' });
    const refreshToken = await this.issueRefreshToken('member', dto.deviceId, { memberId: member.id });
    return { accessToken, refreshToken, member: this.memberPublicShape(member) };
  }

  /**
   * Web/portal login alternative to memberCode+PIN — same account,
   * same rate-limit/lockout/anonymize/status checks, different first
   * factor. A member only has a passwordHash once one has been
   * generated for them (at registration, going forward — see
   * MembersService.registerByBranch), so an older member without an
   * email/password on file simply can't use this path yet and falls
   * back to memberCode+PIN.
   */
  async memberEmailLogin(dto: MemberEmailLoginDto, ip: string) {
    const idKey = `login:member:email:${dto.email}`;
    const ipKey = `login:member:ip:${ip}`;
    await this.rateLimit.assertNotBlocked([idKey, ipKey]);

    const member = await this.prisma.member.findUnique({ where: { email: dto.email } });
    const fail = async () => {
      await this.rateLimit.recordFailure(idKey);
      await this.rateLimit.recordFailure(ipKey);
      throw new UnauthorizedException('Incorrect email or password.');
    };

    if (!member || member.isAnonymized || !member.passwordHash) return fail();
    if (member.status !== 'active') throw new ForbiddenException('This member account is suspended.');
    if (member.lockedUntil && member.lockedUntil > new Date()) {
      throw new AppException('PIN_LOCKED', 'Too many failed attempts. Try again later.', 401);
    }

    const ok = await verifySecret(member.passwordHash, dto.password);
    if (!ok) {
      const attempts = member.failedPinAttempts + 1;
      await this.prisma.member.update({
        where: { id: member.id },
        data: {
          failedPinAttempts: attempts,
          lockedUntil: attempts >= LOCKOUT_THRESHOLD ? new Date(Date.now() + LOCKOUT_MINUTES * 60 * 1000) : undefined,
        },
      });
      return fail();
    }

    await this.rateLimit.clear(idKey);
    await this.prisma.member.update({ where: { id: member.id }, data: { failedPinAttempts: 0, lockedUntil: null } });

    const accessToken = this.tokens.signAccessToken({ sub: member.id, realm: 'member' });
    const refreshToken = await this.issueRefreshToken('member', dto.deviceId, { memberId: member.id });
    return { accessToken, refreshToken, member: this.memberPublicShape(member) };
  }

  /** Member-initiated PIN recovery — OTP to registered phone/email. Delegates to MembersService. */
  async memberPinResetRequest(dto: MemberPinResetRequestDto): Promise<{ ok: true }> {
    await this.members.requestPinResetOtp(dto.memberCode);
    return { ok: true }; // always ok — never reveals whether the member_code exists
  }

  async memberPinResetConfirm(dto: MemberPinResetConfirmDto): Promise<{ ok: true }> {
    await this.members.confirmPinResetOtp(dto.memberCode, dto.otp, dto.newPin);
    return { ok: true };
  }

  // ── Staff realm (trainer / branch_manager) ──────────────────────────
  // 2FA is mandatory for branch_manager (Branch Portal) but deliberately
  // OFF for trainer (Trainer App) — trainers only ever need email +
  // password. See completeStaffSecondFactor() for the role branch.
  async staffLogin(dto: StaffLoginDto, ip: string) {
    const idKey = `login:staff:id:${dto.email}`;
    const ipKey = `login:staff:ip:${ip}`;
    await this.rateLimit.assertNotBlocked([idKey, ipKey]);

    const trainer = await this.prisma.trainer.findUnique({ where: { email: dto.email }, include: { gym: true } });
    const fail = async () => {
      await this.rateLimit.recordFailure(idKey);
      await this.rateLimit.recordFailure(ipKey);
      throw new UnauthorizedException('Incorrect email or password.');
    };
    if (!trainer) return fail();

    const ok = await verifySecret(trainer.passwordHash, dto.password);
    if (!ok) return fail();

    await this.rateLimit.clear(idKey);
    return this.completeStaffSecondFactor(trainer, dto, ip);
  }

  /**
   * Shared by staffLogin and staffGoogleLogin once the first factor is
   * verified: enforces account/gym status, then the TOTP second
   * factor, identically regardless of which first factor was used.
   */
  private async completeStaffSecondFactor(
    trainer: { id: string; name: string; email: string; role: string; gymId: string; status: string; totpEnabled: boolean; totpSecret: string | null; gym: { status: string; tokenVersion: number; name: string } },
    dto: { totp?: string; backupCode?: string; deviceId?: string },
    ip: string,
  ) {
    if (trainer.status !== 'active') throw new ForbiddenException('Your staff account has been suspended.');
    if (trainer.gym.status !== 'active') {
      throw new AppException('GYM_SUSPENDED', 'Your branch has been suspended — contact UV Active support.', 403);
    }

    // Trainer App: password only, no TOTP enrollment/challenge at all.
    // Branch Portal (branch_manager): mandatory 2FA, unchanged below.
    if (trainer.role === 'trainer') {
      const accessToken = this.tokens.signAccessToken({
        sub: trainer.id,
        realm: 'staff',
        role: trainer.role,
        gymId: trainer.gymId,
        gymTokenVersion: trainer.gym.tokenVersion,
      });
      const refreshToken = await this.issueRefreshToken('staff', dto.deviceId, { trainerId: trainer.id });
      await this.auditLog.record({ actorType: 'staff', actorId: trainer.id, action: 'staff.login', targetType: 'trainer', targetId: trainer.id, ip });
      return {
        accessToken,
        refreshToken,
        staff: { id: trainer.id, name: trainer.name, email: trainer.email, role: trainer.role, gymId: trainer.gymId, gymName: trainer.gym.name },
      };
    }

    if (!trainer.totpEnabled) {
      const setupToken = jwt.sign({ sub: trainer.id, purpose: 'staff_totp_setup' }, this.config.get('jwt.staffSecret')!, { expiresIn: '10m' });
      return { setupRequired: true, setupToken };
    }

    if (!dto.totp && !dto.backupCode) {
      return { totpRequired: true };
    }

    const idKey = `login:staff:id:${trainer.email}`;
    const ipKey = `login:staff:ip:${ip}`;
    let secondFactorOk = false;
    if (dto.totp) {
      secondFactorOk = authenticator.check(dto.totp, trainer.totpSecret!);
    } else if (dto.backupCode) {
      secondFactorOk = await this.consumeStaffBackupCode(trainer.id, dto.backupCode);
    }
    if (!secondFactorOk) {
      await this.rateLimit.recordFailure(idKey);
      await this.rateLimit.recordFailure(ipKey);
      throw new UnauthorizedException('Invalid or missing authentication code.');
    }

    const accessToken = this.tokens.signAccessToken({
      sub: trainer.id,
      realm: 'staff',
      role: trainer.role,
      gymId: trainer.gymId,
      gymTokenVersion: trainer.gym.tokenVersion,
    });
    const refreshToken = await this.issueRefreshToken('staff', dto.deviceId, { trainerId: trainer.id });
    await this.auditLog.record({ actorType: 'staff', actorId: trainer.id, action: 'staff.login', targetType: 'trainer', targetId: trainer.id, ip });
    return {
      accessToken,
      refreshToken,
      staff: { id: trainer.id, name: trainer.name, email: trainer.email, role: trainer.role, gymId: trainer.gymId, gymName: trainer.gym.name },
    };
  }

  /**
   * Alternate first factor for the staff realm. The frontend uses
   * Google Identity Services to obtain a signed ID token and posts it
   * here — verified against Google's public keys, never trusted as-is.
   * Google sign-in only ever LINKS to an email that already has a
   * provisioned staff account (branch staff are created by Admin or
   * their branch manager, never self-registered); it can't create one.
   * The mandatory TOTP second factor still applies identically after.
   */
  async staffGoogleLogin(dto: StaffGoogleLoginDto, ip: string) {
    const clientId = this.config.get<string>('google.staffClientId');
    if (!clientId) {
      throw new BadRequestException('Google sign-in is not configured for the Branch Portal yet.');
    }
    const { OAuth2Client } = await import('google-auth-library');
    const client = new OAuth2Client(clientId);

    let payload: { email?: string; email_verified?: boolean; sub?: string } | undefined;
    try {
      const ticket = await client.verifyIdToken({ idToken: dto.idToken, audience: clientId });
      payload = ticket.getPayload();
    } catch {
      throw new UnauthorizedException('Google sign-in could not be verified.');
    }
    if (!payload?.email || !payload.email_verified) {
      throw new UnauthorizedException('Google sign-in could not be verified.');
    }

    let trainer = await this.prisma.trainer.findUnique({ where: { email: payload.email }, include: { gym: true } });
    if (!trainer) {
      // Deliberately do not create an account here — see class doc.
      throw new UnauthorizedException('No Branch Portal account exists for this Google account.');
    }
    if (!trainer.googleId) {
      trainer = await this.prisma.trainer.update({ where: { id: trainer.id }, data: { googleId: payload.sub }, include: { gym: true } });
    }

    return this.completeStaffSecondFactor(trainer, dto, ip);
  }

  /** Mirrors adminTotpSetup for the staff realm. */
  async staffTotpSetup(setupToken: string) {
    const trainer = await this.resolveStaffSetupToken(setupToken);
    const secret = authenticator.generateSecret();
    const plainCodes = Array.from({ length: 10 }, () => generateBackupCode());

    await this.prisma.$transaction(async (tx) => {
      await tx.trainer.update({ where: { id: trainer.id }, data: { totpSecret: secret } });
      await tx.staffBackupCode.deleteMany({ where: { trainerId: trainer.id, usedAt: null } });
      await tx.staffBackupCode.createMany({
        data: await Promise.all(plainCodes.map(async (c) => ({ trainerId: trainer.id, codeHash: await hashSecret(c) }))),
      });
    });

    const otpauthUrl = authenticator.keyuri(trainer.email, this.config.get('totp.issuer')!, secret);
    return { otpauthUrl, secret, backupCodes: plainCodes };
  }

  /** Mirrors adminTotpConfirm for the staff realm. */
  async staffTotpConfirm(dto: StaffTotpConfirmDto) {
    const trainer = await this.resolveStaffSetupToken(dto.setupToken);
    const fresh = await this.prisma.trainer.findUnique({ where: { id: trainer.id }, include: { gym: true } });
    if (!fresh?.totpSecret || !authenticator.check(dto.code, fresh.totpSecret)) {
      throw new BadRequestException('Invalid authentication code.');
    }
    await this.prisma.trainer.update({ where: { id: trainer.id }, data: { totpEnabled: true } });
    const accessToken = this.tokens.signAccessToken({
      sub: fresh.id, realm: 'staff', role: fresh.role, gymId: fresh.gymId, gymTokenVersion: fresh.gym.tokenVersion,
    });
    const refreshToken = await this.issueRefreshToken('staff', undefined, { trainerId: fresh.id });
    await this.auditLog.record({ actorType: 'staff', actorId: fresh.id, action: 'staff.2fa_enabled', targetType: 'trainer', targetId: fresh.id });
    return {
      accessToken, refreshToken,
      staff: { id: fresh.id, name: fresh.name, email: fresh.email, role: fresh.role, gymId: fresh.gymId, gymName: fresh.gym.name },
    };
  }

  private async consumeStaffBackupCode(trainerId: string, code: string): Promise<boolean> {
    const candidates = await this.prisma.staffBackupCode.findMany({ where: { trainerId, usedAt: null } });
    for (const c of candidates) {
      if (await verifySecret(c.codeHash, code)) {
        await this.prisma.staffBackupCode.update({ where: { id: c.id }, data: { usedAt: new Date() } });
        await this.auditLog.record({ actorType: 'staff', actorId: trainerId, action: 'staff.backup_code_used', targetType: 'trainer', targetId: trainerId });
        return true;
      }
    }
    return false;
  }

  private async resolveStaffSetupToken(setupToken: string) {
    let payload: any;
    try {
      payload = jwt.verify(setupToken, this.config.get('jwt.staffSecret')!);
    } catch {
      throw new UnauthorizedException('Setup session expired — please log in again.');
    }
    if (payload.purpose !== 'staff_totp_setup') throw new UnauthorizedException('Invalid setup token.');
    const trainer = await this.prisma.trainer.findUnique({ where: { id: payload.sub } });
    if (!trainer) throw new UnauthorizedException('Staff account not found.');
    return trainer;
  }

  // ── Admin realm (mandatory TOTP, backup codes as fallback) ──────────
  async adminLogin(dto: AdminLoginDto, ip: string) {
    const idKey = `login:admin:id:${dto.email}`;
    const ipKey = `login:admin:ip:${ip}`;
    await this.rateLimit.assertNotBlocked([idKey, ipKey]);

    const admin = await this.prisma.admin.findUnique({ where: { email: dto.email } });
    const fail = async () => {
      await this.rateLimit.recordFailure(idKey);
      await this.rateLimit.recordFailure(ipKey);
      throw new UnauthorizedException('Incorrect email or password.');
    };
    if (!admin) return fail();

    const ok = await verifySecret(admin.passwordHash, dto.password);
    if (!ok) return fail();

    if (!admin.totpEnabled) {
      const setupToken = jwt.sign({ sub: admin.id, purpose: 'totp_setup' }, this.config.get('jwt.adminSecret')!, { expiresIn: '10m' });
      return { setupRequired: true, setupToken };
    }

    // Credentials are correct but no second factor was submitted yet — this
    // is the normal "show the TOTP screen next" step of the two-step admin
    // login UI, not a failed attempt. Must NOT count against rate limiting
    // or every legitimate login would burn one of the 5 allowed attempts.
    if (!dto.totp && !dto.backupCode) {
      return { totpRequired: true };
    }

    let secondFactorOk = false;
    if (dto.totp) {
      secondFactorOk = authenticator.check(dto.totp, admin.totpSecret!);
    } else if (dto.backupCode) {
      secondFactorOk = await this.consumeBackupCode(admin.id, dto.backupCode);
    }
    if (!secondFactorOk) {
      await this.rateLimit.recordFailure(idKey);
      await this.rateLimit.recordFailure(ipKey);
      throw new UnauthorizedException('Invalid or missing authentication code.');
    }

    await this.rateLimit.clear(idKey);
    const accessToken = this.tokens.signAccessToken({ sub: admin.id, realm: 'admin', role: admin.role });
    const refreshToken = await this.issueRefreshToken('admin', dto.deviceId, { adminId: admin.id });
    await this.auditLog.record({ actorType: 'admin', actorId: admin.id, action: 'admin.login', targetType: 'admin', targetId: admin.id, ip });
    return { accessToken, refreshToken, admin: { id: admin.id, name: admin.name, email: admin.email, role: admin.role } };
  }

  /**
   * Returns the TOTP secret AND 10 backup codes together, shown exactly
   * once (spec §4.3). The secret isn't "live" until adminTotpConfirm
   * verifies a real code from the authenticator app — this two-step
   * shape (vs. enabling immediately) avoids an admin locking themselves
   * out with a secret they never actually finished scanning.
   */
  async adminTotpSetup(setupToken: string) {
    const admin = await this.resolveSetupToken(setupToken);
    const secret = authenticator.generateSecret();
    const plainCodes = Array.from({ length: 10 }, () => generateBackupCode());

    await this.prisma.$transaction(async (tx) => {
      await tx.admin.update({ where: { id: admin.id }, data: { totpSecret: secret } });
      await tx.adminBackupCode.deleteMany({ where: { adminId: admin.id, usedAt: null } }); // clear any stale unused set from a prior aborted setup
      await tx.adminBackupCode.createMany({
        data: await Promise.all(plainCodes.map(async (c) => ({ adminId: admin.id, codeHash: await hashSecret(c) }))),
      });
    });

    const otpauthUrl = authenticator.keyuri(admin.email, this.config.get('totp.issuer')!, secret);
    return { otpauthUrl, secret, backupCodes: plainCodes };
  }

  async adminTotpConfirm(dto: AdminTotpConfirmDto) {
    const admin = await this.resolveSetupToken(dto.setupToken);
    const fresh = await this.prisma.admin.findUnique({ where: { id: admin.id } });
    if (!fresh?.totpSecret || !authenticator.check(dto.code, fresh.totpSecret)) {
      throw new BadRequestException('Invalid authentication code.');
    }
    await this.prisma.admin.update({ where: { id: admin.id }, data: { totpEnabled: true } });
    const accessToken = this.tokens.signAccessToken({ sub: fresh.id, realm: 'admin', role: fresh.role });
    const refreshToken = await this.issueRefreshToken('admin', undefined, { adminId: fresh.id });
    return { accessToken, refreshToken, admin: { id: fresh.id, name: fresh.name, email: fresh.email, role: fresh.role } };
  }

  private async consumeBackupCode(adminId: string, code: string): Promise<boolean> {
    const candidates = await this.prisma.adminBackupCode.findMany({ where: { adminId, usedAt: null } });
    for (const c of candidates) {
      if (await verifySecret(c.codeHash, code)) {
        await this.prisma.adminBackupCode.update({ where: { id: c.id }, data: { usedAt: new Date() } });
        await this.auditLog.record({ actorType: 'admin', actorId: adminId, action: 'admin.backup_code_used', targetType: 'admin', targetId: adminId });
        return true;
      }
    }
    return false;
  }

  private async resolveSetupToken(setupToken: string) {
    let payload: any;
    try {
      payload = jwt.verify(setupToken, this.config.get('jwt.adminSecret')!);
    } catch {
      throw new UnauthorizedException('Setup session expired — please log in again.');
    }
    if (payload.purpose !== 'totp_setup') throw new UnauthorizedException('Invalid setup token.');
    const admin = await this.prisma.admin.findUnique({ where: { id: payload.sub } });
    if (!admin) throw new UnauthorizedException('Admin account not found.');
    return admin;
  }

  // ── Staff / Admin password recovery (OTP-based) ─────────────────────
  async forgotPassword(realm: 'staff' | 'admin', dto: ForgotPasswordDto): Promise<{ ok: true }> {
    const account = realm === 'staff'
      ? await this.prisma.trainer.findUnique({ where: { email: dto.email } })
      : await this.prisma.admin.findUnique({ where: { email: dto.email } });

    // Always return ok — never reveal whether the email exists.
    if (!account) return { ok: true };

    const otp = generateOtp();
    const tokenHash = await hashSecret(otp);
    await this.prisma.passwordResetToken.create({
      data: {
        accountType: realm, accountId: account.id, tokenHash,
        expiresAt: new Date(Date.now() + RESET_TOKEN_TTL_MINUTES * 60 * 1000),
      },
    });

    await this.notifications.notify({
      recipientType: realm === 'staff' ? 'trainer' : 'admin', recipientId: account.id, type: 'password_reset_otp',
      title: 'Your UV Active password reset code',
      body: `Your password reset code is ${otp}. It expires in ${RESET_TOKEN_TTL_MINUTES} minutes. If you didn't request this, you can ignore this email.`,
      channel: 'email', recipientAddress: account.email,
    });
    return { ok: true };
  }

  async resetPassword(realm: 'staff' | 'admin', dto: ResetPasswordDto): Promise<{ ok: true }> {
    const account = realm === 'staff'
      ? await this.prisma.trainer.findUnique({ where: { email: dto.email } })
      : await this.prisma.admin.findUnique({ where: { email: dto.email } });
    if (!account) throw new UnauthorizedException('This code is invalid or has expired.');

    // Same "try the last few unexpired candidates" shape as
    // MembersService.confirmPinResetOtp — an OTP is only ever compared
    // via its hash, never stored or logged in plaintext.
    const candidates = await this.prisma.passwordResetToken.findMany({
      where: { accountType: realm, accountId: account.id, usedAt: null, expiresAt: { gt: new Date() } },
      orderBy: { createdAt: 'desc' },
      take: 5,
    });
    let matched: (typeof candidates)[number] | null = null;
    for (const c of candidates) {
      if (await verifySecret(c.tokenHash, dto.otp)) { matched = c; break; }
    }
    if (!matched) throw new UnauthorizedException('This code is invalid or has expired.');

    const passwordHash = await hashSecret(dto.newPassword);
    if (realm === 'staff') {
      await this.prisma.trainer.update({ where: { id: account.id }, data: { passwordHash } });
      await this.prisma.refreshToken.updateMany({ where: { trainerId: account.id, revokedAt: null }, data: { revokedAt: new Date() } });
    } else {
      await this.prisma.admin.update({ where: { id: account.id }, data: { passwordHash } });
      await this.prisma.refreshToken.updateMany({ where: { adminId: account.id, revokedAt: null }, data: { revokedAt: new Date() } });
    }
    await this.prisma.passwordResetToken.update({ where: { id: matched.id }, data: { usedAt: new Date() } });
    await this.auditLog.record({ actorType: realm === 'staff' ? 'staff' : 'admin', actorId: account.id, action: `${realm}.password_reset`, targetType: realm, targetId: account.id });
    return { ok: true };
  }

  // ── Authenticated "change my own password" (Branch Portal Settings) ──
  // Requires the CURRENT password, unlike resetPassword() above (which
  // is the logged-out recovery path gated by an emailed OTP instead).
  // Revokes every other refresh token for this account — same as a
  // password reset — since a password change is exactly the moment an
  // old, possibly-compromised session should stop being valid too.
  async changeOwnPassword(realm: 'staff' | 'admin', accountId: string, dto: ChangePasswordDto): Promise<{ ok: true }> {
    const account = realm === 'staff'
      ? await this.prisma.trainer.findUnique({ where: { id: accountId } })
      : await this.prisma.admin.findUnique({ where: { id: accountId } });
    if (!account) throw new UnauthorizedException('Account not found.');

    const valid = await verifySecret(account.passwordHash, dto.currentPassword);
    if (!valid) throw new UnauthorizedException('Current password is incorrect.');

    const passwordHash = await hashSecret(dto.newPassword);
    if (realm === 'staff') {
      await this.prisma.trainer.update({ where: { id: accountId }, data: { passwordHash } });
      await this.prisma.refreshToken.updateMany({ where: { trainerId: accountId, revokedAt: null }, data: { revokedAt: new Date() } });
    } else {
      await this.prisma.admin.update({ where: { id: accountId }, data: { passwordHash } });
      await this.prisma.refreshToken.updateMany({ where: { adminId: accountId, revokedAt: null }, data: { revokedAt: new Date() } });
    }
    await this.auditLog.record({ actorType: realm === 'staff' ? 'staff' : 'admin', actorId: accountId, action: `${realm}.password_change`, targetType: realm, targetId: accountId });
    return { ok: true };
  }

  // ── Refresh / logout (shared across realms) ─────────────────────────
  private async issueRefreshToken(
    realm: 'member' | 'staff' | 'admin',
    deviceId: string | undefined,
    owner: { memberId?: string; trainerId?: string; adminId?: string },
  ): Promise<string> {
    const ttlDays = this.config.get<number>('jwt.refreshTtlDays')!;
    const { token, hash, expiresAt } = this.tokens.generateRefreshToken(ttlDays);
    await this.prisma.refreshToken.create({
      data: { realm, tokenHash: hash, deviceId, expiresAt, ...owner },
    });
    return token;
  }

  async refresh(realm: 'member' | 'staff' | 'admin', refreshToken: string) {
    const hash = this.tokens.hashRefreshToken(refreshToken);
    const row = await this.prisma.refreshToken.findUnique({ where: { tokenHash: hash } });
    if (!row || row.realm !== realm || row.revokedAt || row.expiresAt < new Date()) {
      throw new UnauthorizedException('Session expired — please log in again.');
    }

    if (realm === 'member' && row.memberId) {
      const member = await this.prisma.member.findUnique({ where: { id: row.memberId } });
      if (!member || member.status !== 'active' || member.isAnonymized) throw new UnauthorizedException('Account unavailable.');
      return { accessToken: this.tokens.signAccessToken({ sub: member.id, realm: 'member' }) };
    }
    if (realm === 'staff' && row.trainerId) {
      const trainer = await this.prisma.trainer.findUnique({ where: { id: row.trainerId }, include: { gym: true } });
      if (!trainer || trainer.status !== 'active' || trainer.gym.status !== 'active') {
        throw new UnauthorizedException('Account or branch unavailable.');
      }
      return {
        accessToken: this.tokens.signAccessToken({
          sub: trainer.id,
          realm: 'staff',
          role: trainer.role,
          gymId: trainer.gymId,
          gymTokenVersion: trainer.gym.tokenVersion, // always re-fetched fresh, never cached from the old token
        }),
      };
    }
    if (realm === 'admin' && row.adminId) {
      const admin = await this.prisma.admin.findUnique({ where: { id: row.adminId } });
      if (!admin) throw new UnauthorizedException('Account unavailable.');
      return { accessToken: this.tokens.signAccessToken({ sub: admin.id, realm: 'admin', role: admin.role }) };
    }
    throw new UnauthorizedException('Session expired — please log in again.');
  }

  async logout(realm: 'member' | 'staff' | 'admin', refreshToken: string): Promise<void> {
    const hash = this.tokens.hashRefreshToken(refreshToken);
    await this.prisma.refreshToken.updateMany({
      where: { tokenHash: hash, realm, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  private memberPublicShape(m: { id: string; memberCode: string; name: string; phone: string | null; email: string | null; photoUrl: string | null; currentGymId: string | null }) {
    return { id: m.id, memberCode: m.memberCode, name: m.name, phone: m.phone, email: m.email, photoUrl: m.photoUrl, currentGymId: m.currentGymId };
  }
}