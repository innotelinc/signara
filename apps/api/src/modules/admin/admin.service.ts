import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { AuthenticatedUser } from '../../common/types';

/**
 * Platform administration across all tenants. Every method enforces the
 * PLATFORM_ADMIN platform role (IdP group `signara-admins`).
 */
@Injectable()
export class AdminService {
  constructor(private readonly prisma: PrismaService) {}

  private assertPlatformAdmin(user: AuthenticatedUser): void {
    if (user.platformRole !== 'PLATFORM_ADMIN') {
      throw new ForbiddenException('Platform administrator role required');
    }
  }

  async listOrganizations(user: AuthenticatedUser, query: { search?: string; status?: string; limit?: number; offset?: number }) {
    this.assertPlatformAdmin(user);
    const where = {
      deletedAt: null,
      ...(query.status ? { status: query.status as never } : {}),
      ...(query.search ? { OR: [{ name: { contains: query.search, mode: 'insensitive' as const } }, { slug: { contains: query.search, mode: 'insensitive' as const } }] } : {}),
    };
    const [total, items] = await this.prisma.$transaction([
      this.prisma.organization.count({ where }),
      this.prisma.organization.findMany({
        where,
        include: {
          billingAccount: { select: { plan: true, status: true } },
          _count: { select: { memberships: true, documents: true } },
        },
        orderBy: { createdAt: 'desc' },
        skip: query.offset ?? 0,
        take: Math.min(query.limit ?? 25, 200),
      }),
    ]);
    return { total, items };
  }

  async listUsers(user: AuthenticatedUser, query: { search?: string; status?: string; limit?: number; offset?: number }) {
    this.assertPlatformAdmin(user);
    const where = {
      deletedAt: null,
      ...(query.status ? { status: query.status as never } : {}),
      ...(query.search ? { OR: [{ email: { contains: query.search, mode: 'insensitive' as const } }, { displayName: { contains: query.search, mode: 'insensitive' as const } }] } : {}),
    };
    const [total, items] = await this.prisma.$transaction([
      this.prisma.user.count({ where }),
      this.prisma.user.findMany({
        where,
        select: {
          id: true,
          email: true,
          displayName: true,
          status: true,
          platformRole: true,
          mfaEnabled: true,
          lastLoginAt: true,
          createdAt: true,
          _count: { select: { memberships: true } },
        },
        orderBy: { createdAt: 'desc' },
        skip: query.offset ?? 0,
        take: Math.min(query.limit ?? 25, 200),
      }),
    ]);
    return { total, items };
  }

  async setOrganizationStatus(user: AuthenticatedUser, id: string, status: 'ACTIVE' | 'SUSPENDED' | 'CANCELED'): Promise<{ id: string; status: string }> {
    this.assertPlatformAdmin(user);
    const org = await this.prisma.organization.findUnique({ where: { id } });
    if (!org) throw new NotFoundException('Organization not found');

    await this.prisma.organization.update({ where: { id }, data: { status } });
    // Suspending a tenant: revoke all of its sessions to force re-authentication.
    if (status === 'SUSPENDED') {
      await this.prisma.session.updateMany({
        where: { user: { memberships: { some: { organizationId: id } } } },
        data: { revokedAt: new Date() },
      });
    }
    return { id, status };
  }

  async setUserStatus(user: AuthenticatedUser, id: string, status: 'ACTIVE' | 'SUSPENDED' | 'DEACTIVATED'): Promise<{ id: string; status: string }> {
    this.assertPlatformAdmin(user);
    await this.prisma.user.update({
      where: { id },
      data: { status },
    });
    if (status !== 'ACTIVE') {
      await this.prisma.session.updateMany({ where: { userId: id }, data: { revokedAt: new Date() } });
    }
    return { id, status };
  }

  /** Cross-tenant platform metrics. */
  async metrics(user: AuthenticatedUser) {
    this.assertPlatformAdmin(user);
    const [organizations, users, documents, completedRequests, activeSigningRequests, auditEvents24h] =
      await this.prisma.$transaction([
        this.prisma.organization.count({ where: { deletedAt: null } }),
        this.prisma.user.count({ where: { deletedAt: null } }),
        this.prisma.document.count({ where: { deletedAt: null } }),
        this.prisma.signingRequest.count({ where: { status: 'COMPLETED' } }),
        this.prisma.signingRequest.count({ where: { status: { in: ['AWAITING_SIGNATURE', 'IN_PROGRESS'] } } }),
        this.prisma.auditLog.count({ where: { createdAt: { gte: new Date(Date.now() - 24 * 60 * 60 * 1000) } } }),
      ]);
    return {
      generatedAt: new Date().toISOString(),
      counts: { organizations, users, documents, completedRequests, activeSigningRequests },
      auditEvents24h,
    };
  }
}