import {
  CallHandler,
  ExecutionContext,
  Injectable,
  Logger,
  NestInterceptor,
} from '@nestjs/common';
import { Observable, tap } from 'rxjs';
import { AuditOutcome } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';

const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * Appends an AuditLog row for every mutating request. The row is written
 * after the response completes so failures are captured with their outcome.
 * Public signer endpoints annotate themselves via `res.locals.auditResource`.
 */
@Injectable()
export class AuditInterceptor implements NestInterceptor {
  private readonly logger = new Logger('Audit');

  constructor(private readonly prisma: PrismaService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== 'http') return next.handle();
    const req = context.switchToHttp().getRequest();
    const res = context.switchToHttp().getResponse();
    if (!MUTATING_METHODS.has(req.method)) return next.handle();

    const startedOn = Date.now();
    return next.handle().pipe(
      tap({
        next: () => this.record(req, res, AuditOutcome.SUCCESS, Date.now() - startedOn),
        error: () => this.record(req, res, AuditOutcome.FAILURE, Date.now() - startedOn),
      }),
    );
  }

  private async record(req: any, res: any, outcome: AuditOutcome, durationMs: number): Promise<void> {
    try {
      const resource = res.locals?.auditResource ?? {
        type: req.route?.path?.split('/').filter(Boolean).join('.') || 'unknown',
        id: req.params?.id,
      };
      await this.prisma.auditLog.create({
        data: {
          organizationId: req.user?.org?.id ?? null,
          actorUserId: req.user?.id ?? null,
          actorEmail: req.user?.email ?? null,
          action: `${req.method} ${req.route?.path ?? req.url}`,
          resourceType: typeof resource.type === 'string' ? resource.type : 'unknown',
          resourceId: resource.id ?? null,
          outcome,
          metadata: { durationMs, requestId: req.requestId },
          ipAddress: req.ip,
          userAgent: req.headers['user-agent']?.slice(0, 500),
        },
      });
    } catch (err) {
      this.logger.warn(`Failed to write audit log: ${(err as Error).message}`);
    }
  }
}