import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus, Logger } from '@nestjs/common';
import { Request, Response } from 'express';
import { AppException } from '../exceptions/app.exception';

// Fallback codes for the standard Nest exceptions thrown all over the
// codebase that AREN'T one of the spec-named AppException cases — this
// is what guarantees §14's promise that clients can always match on
// `error.code`, never on message text, even for a plain NotFoundException.
const STATUS_TO_GENERIC_CODE: Record<number, string> = {
  400: 'BAD_REQUEST',
  401: 'UNAUTHORIZED',
  403: 'FORBIDDEN',
  404: 'NOT_FOUND',
  409: 'CONFLICT',
  422: 'UNPROCESSABLE_ENTITY',
  429: 'TOO_MANY_REQUESTS',
  500: 'INTERNAL_ERROR',
};

@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger('ExceptionFilter');

  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const res = ctx.getResponse<Response>();
    const req = ctx.getRequest<Request>();

    const isHttp = exception instanceof HttpException;
    const status = isHttp ? exception.getStatus() : HttpStatus.INTERNAL_SERVER_ERROR;

    let code: string;
    let message: string;

    if (exception instanceof AppException) {
      code = exception.code;
      message = (exception.getResponse() as any).message;
    } else if (isHttp) {
      const body = exception.getResponse();
      code = STATUS_TO_GENERIC_CODE[status] || 'ERROR';
      message = typeof body === 'string' ? body : (body as any).message || 'Request failed.';
      // class-validator's ValidationPipe returns message as a string[] — flatten for a stable shape.
      if (Array.isArray(message)) message = message.join(' ');
    } else {
      code = 'INTERNAL_ERROR';
      message = 'Internal server error';
      this.logger.error(`Unhandled error on ${req.method} ${req.url}`, exception as Error);
    }

    res.status(status).json({ success: false, error: { code, message }, path: req.url });
  }
}
