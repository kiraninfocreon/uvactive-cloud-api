import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { Observable } from 'rxjs';
import { map } from 'rxjs/operators';

/**
 * Spec §14's success envelope: { success: true, data: {...}, meta?: {...} }.
 * A handler that already returns { data, meta } (a paginated list, for
 * instance) gets that shape preserved as-is inside `data`/`meta`
 * top-level keys; everything else is wrapped as `data` verbatim. This
 * keeps every controller free to just `return` its normal payload
 * without knowing about the envelope.
 */
@Injectable()
export class ResponseEnvelopeInterceptor implements NestInterceptor {
  intercept(ctx: ExecutionContext, next: CallHandler): Observable<any> {
    const req = ctx.switchToHttp().getRequest();
    // /health is consumed by the load balancer and uptime monitor in
    // its own documented shape (spec §14) — never wrapped.
    if (req?.originalUrl?.includes('/health')) return next.handle();

    return next.handle().pipe(
      map((payload) => {
        if (payload && typeof payload === 'object' && 'data' in payload && 'meta' in payload) {
          return { success: true, data: payload.data, meta: payload.meta };
        }
        return { success: true, data: payload };
      }),
    );
  }
}
