import { IsBoolean, IsDateString, IsEmail, IsIn, IsInt, IsNumber, IsOptional, IsString, Length, Max, Min } from 'class-validator';

const SEX_VALUES = ['male', 'female', 'other'] as const;

export class RegisterMemberDto {
  @IsString() name!: string;
  @IsOptional() @IsString() phone?: string;
  // Required going forward — a member's email is now also their web
  // login identity (alongside memberCode+PIN), so registration can't
  // skip it the way it optionally could before.
  @IsEmail() email!: string;
  @IsOptional() @IsDateString() dob?: string;
  @IsOptional() @IsString() photoUrl?: string;

  // Bio fields — mandatory on both the Admin Panel and Branch Portal
  // member-creation forms (used for BMI / max-HR and the member detail
  // screen's stat tiles).
  @IsIn(SEX_VALUES) sex!: 'male' | 'female' | 'other';
  @IsInt() @Min(1) @Max(120) ageYears!: number;
  @IsNumber() @Min(1) heightCm!: number;
  @IsNumber() @Min(1) weightKg!: number;
  @IsInt() @Min(1) restingHr!: number;

  // Consent capture is required at registration, not a decorative
  // checkbox — HR/biometric data is being collected (spec §10). The
  // registering staff member is confirming the member has been
  // informed and consents; this is logged with a version + timestamp.
  @IsString() consentVersion!: string;
  @IsBoolean() consentAccepted!: boolean;
}

// Admin Panel member creation — same mandatory bio fields as branch
// registration, but no gym assignment (admin-created members start
// unassigned and get placed via the transfer-request flow) and no
// branch-desk consent capture, since there's no member physically
// present to consent — a system consent row is still recorded server-
// side for the same audit-trail guarantee (see MembersService.registerByAdmin).
export class AdminRegisterMemberDto {
  @IsString() name!: string;
  @IsString() phone!: string;
  @IsEmail() email!: string;
  @IsIn(SEX_VALUES) sex!: 'male' | 'female' | 'other';
  @IsInt() @Min(1) @Max(120) ageYears!: number;
  @IsNumber() @Min(1) heightCm!: number;
  @IsNumber() @Min(1) weightKg!: number;
  @IsInt() @Min(1) restingHr!: number;
}

export class UpdateMemberDto {
  @IsOptional() @IsString() name?: string;
  @IsOptional() @IsString() phone?: string;
  @IsOptional() @IsEmail() email?: string;
  @IsOptional() @IsDateString() dob?: string;
  @IsOptional() @IsString() photoUrl?: string;
  @IsOptional() @IsIn(SEX_VALUES) sex?: 'male' | 'female' | 'other';
  @IsOptional() @IsInt() @Min(1) @Max(120) ageYears?: number;
  @IsOptional() @IsNumber() @Min(1) heightCm?: number;
  @IsOptional() @IsNumber() @Min(1) weightKg?: number;
  @IsOptional() @IsInt() @Min(1) restingHr?: number;
}

// Member App "Settings > Edit details" — bio fields only, see
// MembersService.updateOwnBio. Deliberately excludes name/phone/email:
// those stay editable only from the Branch Portal / Admin Panel.
export class MemberSelfUpdateDto {
  @IsOptional() @IsIn(SEX_VALUES) sex?: 'male' | 'female' | 'other';
  @IsOptional() @IsInt() @Min(1) @Max(120) ageYears?: number;
  @IsOptional() @IsNumber() @Min(1) heightCm?: number;
  @IsOptional() @IsNumber() @Min(1) weightKg?: number;
  @IsOptional() @IsInt() @Min(1) restingHr?: number;
  @IsOptional() @IsString() photoUrl?: string;
}

export class ReleaseMemberDto {
  @IsOptional() @IsString() reason?: string;
}

export class AdminAssignMemberDto {
  @IsString() gymId!: string;
  @IsOptional() @IsString() reason?: string;
}

export class ChangePinDto {
  @IsString() @Length(6, 6) currentPin!: string;
  @IsString() @Length(6, 6) newPin!: string;
}

// Shared shape for both the member and trainer push-token endpoints —
// null clears the token (logout / permission revoked), a string
// registers/rotates it. Expo tokens look like
// "ExponentPushToken[xxxxxxxxxxxxxxxxxxxxxx]" but length is
// deliberately not validated tightly here since Expo's own token
// format has changed shape before and rejecting a legitimate token at
// this layer would be a worse failure mode than storing an odd one.
export class SetPushTokenDto {
  @IsOptional() @IsString() token!: string | null;
}

export class MemberPinResetRequestDto {
  @IsString() memberCode!: string;
}

export class MemberPinResetConfirmDto {
  @IsString() memberCode!: string;
  @IsString() @Length(6, 6) otp!: string;
  @IsString() @Length(6, 6) newPin!: string;
}

// super_admin must re-confirm their own password before anonymizing a
// member — this is a one-way, high-consequence action (spec §9).
export class AnonymizeMemberDto {
  @IsString() adminPassword!: string;
}
