import { ForbiddenException, Injectable } from '@nestjs/common';
import { AuditOutcome, Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { AuthenticatedUser } from '../../common/types';

@Injectable()
export class AuditService {
  constructor(private readonly prisma: PrismaService) {}

  /** Tenant-scoped audit log query. */
  async list(
    user: AuthenticatedUser,
    query: {
      action?: string;
      resourceType?: string;
      resourceId?: string;
      outcome?: AuditOutcome;
      actorEmail?: string;
      from?: Date;
      to?: Date;
      limit?: number;
      offset?: number;
    },
  ) {
    const orgId = user.org?.id;
    if (!orgId) throw new ForbiddenException('No active tenant');

    // Platform admins may query across tenants when no tenant context exists.
    const where: Prisma.AuditLogWhereInput = {
      ...(orgId ? { organizationId: orgId } : {}),
      ...(query.action ? { action: { contains: query.action } } : {}),
      ...(query.resourceType ? { resourceType: query.resourceType } : {}),
      ...(query.resourceId ? { resourceId: query.resourceId } : {}),
      ...(query.outcome ? { outcome: query.outcome } : {}),
      ...(query.actorEmail ? { actorEmail: query.actorEmail } : {}),
      ...(query.from || query.to ? { createdAt: { gte: query.from, lte: query.to } } : {}),
    };

    const [total, items] = await this.prisma.$transaction([
      this.prisma.auditLog.count({ where }),
      this.prisma.auditLog.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: query.offset ?? 0,
        take: Math.min(query.limit ?? 100, 500),
      }),
    ]);
    return { total, items };
  }

  /** CSV export of the matching audit rows (for compliance archives). */
  async export(user: AuthenticatedUser, query: { from?: Date; to?: Date; action?: string }): Promise<string> {
    const orgId = user.org?.id!;
    const rows = await this.prisma.auditLog.findMany({
      where: {
        organizationId: orgId,
        ...(query.action ? { action: { contains: query.action } } : {}),
        ...(query.from || query.to ? { createdAt: { gte: query.from, lte: query.to } } : {}),
      },
      orderBy: { createdAt: 'asc' },
      take: 50_000,
    });

    const header = 'timestamp,actor,action,resourceType,resourceId,outcome,ipAddress,userAgent,metadata';
    const escape = (v: unknown) => `"${String(v ?? '').replaceAll('"', '""')}"`;
    const lines = rows.map((r) =>
      [
        escape(r.createdAt.toISOString()),
        escape(r.actorEmail),
        escape(r.action),
        escape(r.resourceType),
        escape(r.resourceId),
        escape(r.outcome),
        escape(r.ipAddress),
        escape(r.userAgent),
        escape(JSON.stringify(r.metadata ?? {})),
      ].join(','),
    );
    return [header, ...lines].join('\n');
  }

  /** Writes an audit row programmatically (used by services). */
  async record(input: {
    organizationId?: string | null;
    actorUserId?: string | null;
    actorEmail?: string | null;
    action: string;
    resourceType: string;
    resourceId?: string | null;
    outcome?: AuditOutcome;
    metadata?: Record<string, unknown>;
    ipAddress?: string | null;
    userAgent?: string | null;
  }): Promise<void> {
    await this.prisma.auditLog.create({
      data: {
        organizationId: input.organizationId,
        actorUserId: input.actorUserId,
        actorEmail: input.actorEmail,
        action: input.action,
        resourceType: input.resourceType,
        resourceId: input.resourceId,
        outcome: input.outcome ?? AuditOutcome.SUCCESS,
        metadata: input.metadata as object | undefined,
        ipAddress: input.ipAddress,
        userAgent: input.userAgent?.slice(0, 500),
      },
    });
  }
}