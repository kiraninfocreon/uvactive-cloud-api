import { Transform } from 'class-transformer';

/**
 * Root cause of the recurring "X must be an email" (or "must be a
 * valid ISO 8601 date string", etc.) error on fields the user left
 * blank:
 *
 * class-validator's @IsOptional() only skips the remaining validators
 * on a property when the value is `null` or `undefined`. It does NOT
 * treat an empty string as "not provided" — and browser forms almost
 * always send blank inputs as `""`, not as a missing key. So
 * `@IsOptional() @IsEmail() contactEmail?: string` still runs
 * @IsEmail() against `""`, which fails.
 *
 * Fix: normalize blank/whitespace-only strings to `undefined` BEFORE
 * validation runs. Stack this decorator ABOVE @IsOptional() (i.e.
 * list it first) on every optional field that also carries a format
 * validator — @IsEmail, @IsDateString, @IsUrl, @Matches, @IsUUID,
 * @IsEnum, etc. Plain @IsString()-only optional fields don't need
 * this, since an empty string is itself a valid string.
 *
 * Example:
 *   @EmptyToUndefined() @IsOptional() @IsEmail() contactEmail?: string;
 */
export function EmptyToUndefined() {
  return Transform(({ value }) => (typeof value === 'string' && value.trim() === '' ? undefined : value));
}
