import { IsEmail, IsInt, IsOptional, IsString, Min, MinLength } from 'class-validator';

export class CreateGymDto {
  @IsString() name!: string;
  @IsString() address!: string;
  @IsString() location!: string;
  @IsString() gymPhone!: string;
  @IsOptional() @IsString() ownerContact?: string;
  @IsOptional() @IsEmail() contactEmail?: string;
  @IsInt() @Min(1) memberLimit!: number;

  // A gym is useless without someone who can log in to run it — this is
  // NOT optional. Creating the Gym row without also creating its
  // branch-manager staff account was the original bug: admins could
  // create a gym that no one could ever log into. One request, one
  // gym, one login.
  @IsString() managerName!: string;
  @IsEmail() managerEmail!: string;
  // Mandatory on gym creation per spec — every other field on this
  // form is mandatory too, and a manager account with no contact
  // number on file was a support-recovery dead end in practice.
  @IsString() managerPhone!: string;
}

// Settings screen (Branch Portal) — deliberately excludes memberLimit
// (Admin-controlled cap) and the manager's own email/phone (those live
// on the Trainer row and are admin-only to change — spec: "not the
// email id of manager and phone number, cannot get changed only by
// admin can do"). Gym name/address/location/gymPhone ARE branch-
// editable per that same spec section.
export class UpdateGymProfileDto {
  @IsOptional() @IsString() name?: string;
  @IsOptional() @IsString() address?: string;
  @IsOptional() @IsString() location?: string;
  @IsOptional() @IsString() gymPhone?: string;
  @IsOptional() @IsString() ownerContact?: string;
  @IsOptional() @IsEmail() contactEmail?: string;
}
export class UpdateGymDto {
  @IsOptional() @IsString() name?: string;
  @IsOptional() @IsString() address?: string;
  @IsOptional() @IsString() location?: string;
  @IsOptional() @IsString() gymPhone?: string;
  @IsOptional() @IsString() ownerContact?: string;
  @IsOptional() @IsEmail() contactEmail?: string;
  @IsOptional() @IsInt() @Min(1) memberLimit?: number;
}

// Lets an admin (from the Gyms screen) issue a brand-new temporary
// password for a branch's primary manager account, e.g. if the
// original credentials email never arrived. Returns the plaintext
// once, same shape as gym creation.
export class ResetGymManagerPasswordDto {
  @IsOptional() @IsString() @MinLength(8) newPassword?: string;
}

// Admin-only editing of the manager's OWN identity fields (name/
// email/phone) — the one path allowed by "not the email id of
// manager and phone number, cannot get changed only by admin can do".
// Deliberately never touches the password (see ResetGymManagerPasswordDto
// above for that) or which trainer row is the manager.
export class UpdateGymManagerDto {
  @IsOptional() @IsString() name?: string;
  @IsOptional() @IsEmail() email?: string;
  @IsOptional() @IsString() phone?: string;
}
