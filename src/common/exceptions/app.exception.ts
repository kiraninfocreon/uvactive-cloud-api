import { HttpException, HttpStatus } from '@nestjs/common';

/**
 * Clients match on `error.code`, never on message text (spec §14).
 * Use this instead of a plain Nest HttpException wherever the spec
 * names a specific code (GYM_SUSPENDED, MEMBER_LIMIT_REACHED,
 * PIN_LOCKED, SESSION_FULL, TRANSFER_ALREADY_RESPONDED, etc.) — for
 * everything else, AllExceptionsFilter falls back to a generic code
 * derived from the HTTP status so no response is ever left codeless.
 */
export class AppException extends HttpException {
  public readonly code: string;

  constructor(code: string, message: string, status: HttpStatus = HttpStatus.BAD_REQUEST) {
    super({ code, message }, status);
    this.code = code;
  }
}
