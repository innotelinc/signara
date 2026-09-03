import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { Observable, tap } from 'rxjs';
import { httpRequestDurationSeconds, httpRequestsTotal } from '../metrics';

@Injectable()
export class MetricsInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== 'http') return next.handle();

    const http = context.switchToHttp();
    const request = http.getRequest();
    const response = http.getResponse();
    const startedAt = process.hrtime.bigint();

    const observe = (error?: unknown) => {
      const route = request.route?.path ?? request.path ?? 'unknown';
      const method = request.method ?? 'UNKNOWN';
      const exceptionStatus =
        typeof (error as { getStatus?: () => unknown } | undefined)?.getStatus === 'function'
          ? (error as { getStatus: () => unknown }).getStatus()
          : undefined;
      const statusCode =
        typeof exceptionStatus === 'number' ? exceptionStatus : Number(response.statusCode ?? 500);
      const status = String(statusCode || 500);
      const durationSeconds = Number(process.hrtime.bigint() - startedAt) / 1e9;
      httpRequestsTotal.inc({ method, route, status });
      httpRequestDurationSeconds.observe({ method, route }, durationSeconds);
    };

    return next.handle().pipe(tap({ next: () => observe(), error: (error) => observe(error) }));
  }
}
