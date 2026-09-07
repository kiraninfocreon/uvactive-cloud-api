import { randomInt } from 'crypto';

// Base32 alphabet with ambiguous characters (0/O/1/I) excluded, per the
// Cloud API spec §3.2. Server-generated only — never client-supplied,
// never editable.
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export function generateMemberCode(): string {
  let suffix = '';
  for (let i = 0; i < 6; i++) {
    suffix += ALPHABET[randomInt(0, ALPHABET.length)];
  }
  return `UVA-${suffix}`;
}

export function generatePin(): string {
  // 6-digit numeric, cryptographically secure. Leading zeros preserved.
  return String(randomInt(0, 1_000_000)).padStart(6, '0');
}

// Same shape as generatePin (6-digit numeric), but named separately
// since it's used for one-time verification codes (forgot-password
// flows) rather than a standing login credential.
export const generateOtp = generatePin;

// Admin 2FA backup codes: 10 chars, base32-ish alphabet, grouped for
// readability (XXXX-XXXX-XX). Shown exactly once at setup time.
const BACKUP_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export function generateBackupCode(): string {
  let raw = '';
  for (let i = 0; i < 10; i++) raw += BACKUP_ALPHABET[randomInt(0, BACKUP_ALPHABET.length)];
  return `${raw.slice(0, 4)}-${raw.slice(4, 8)}-${raw.slice(8, 10)}`;
}

// Server-generated temporary password for auto-created staff accounts
// (e.g. a gym's primary branch-manager, created alongside the Gym
// itself). Never client-supplied. Mixed-case + digits + a symbol so it
// clears typical password-strength checks, shown to the admin exactly
// once in the create-gym response and then only ever exists as a hash.
const PASSWORD_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
const PASSWORD_SYMBOLS = '!@#$%*';
export function generateTempPassword(): string {
  let raw = '';
  for (let i = 0; i < 10; i++) raw += PASSWORD_CHARS[randomInt(0, PASSWORD_CHARS.length)];
  const symbol = PASSWORD_SYMBOLS[randomInt(0, PASSWORD_SYMBOLS.length)];
  const digit = String(randomInt(0, 10));
  return `${raw}${symbol}${digit}`;
}
