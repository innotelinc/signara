import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { WorkspaceVisibility } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { AuthenticatedUser } from '../../common/types';

@Injectable()
export class OrganizationsService {
  constructor(private readonly prisma: PrismaService) {}

  /** Active organization for the caller (guarded by tenant resolution). */
  async getCurrent(user: AuthenticatedUser) {
    const orgId = user.org?.id;
    if (!orgId) throw new ForbiddenException('No active tenant');

    const org = await this.prisma.organization.findUnique({
      where: { id: orgId },
      include: {
        billingAccount: {
          select: { plan: true, status: true, seatsLimit: true, currentPeriodEnd: true },
        },
        _count: { select: { memberships: true, documents: true, workspaces: true } },
      },
    });
    if (!org) throw new NotFoundException('Organization not found');
    return org;
  }

  async updateCurrent(
    user: AuthenticatedUser,
    data: { name?: string; legalName?: string; taxId?: string; branding?: unknown },
  ) {
    const orgId = user.org?.id;
    if (!orgId) throw new ForbiddenException('No active tenant');
    this.assertAdmin(user);

    return this.prisma.organization.update({
      where: { id: orgId },
      data: {
        name: data.name,
        legalName: data.legalName,
        taxId: data.taxId,
        branding: data.branding as object | undefined,
      },
    });
  }

  async listWorkspaces(user: AuthenticatedUser) {
    const orgId = user.org?.id!;
    return this.prisma.workspace.findMany({
      where: { organizationId: orgId },
      orderBy: { createdAt: 'asc' },
    });
  }

  async createWorkspace(
    user: AuthenticatedUser,
    data: { name: string; slug?: string; description?: string; visibility?: WorkspaceVisibility },
  ) {
    const orgId = user.org?.id!;
    this.assertManager(user);
    const slug =
      data.slug ??
      data.name
        .toLowerCase()
        .replace(/[^a-z0-9-]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 60);
    return this.prisma.workspace.create({
      data: {
        organizationId: orgId,
        name: data.name,
        slug,
        description: data.description,
        visibility: data.visibility,
        createdById: user.id,
      },
    });
  }

  async listTeams(user: AuthenticatedUser, workspaceId?: string) {
    const orgId = user.org?.id!;
    if (workspaceId) await this.assertWorkspaceInTenant(orgId, workspaceId);
    return this.prisma.team.findMany({
      where: { organizationId: orgId, ...(workspaceId ? { workspaceId } : {}) },
      include: { _count: { select: { members: true } } },
      orderBy: { createdAt: 'asc' },
    });
  }

  async createTeam(
    user: AuthenticatedUser,
    data: { name: string; description?: string; workspaceId?: string; memberIds?: string[] },
  ) {
    const orgId = user.org?.id!;
    this.assertManager(user);
    if (data.workspaceId) await this.assertWorkspaceInTenant(orgId, data.workspaceId);
    let members: Array<{ userId: string }> = [];
    if (data.memberIds?.length) {
      members = await this.prisma.membership.findMany({
        where: { organizationId: orgId, userId: { in: data.memberIds } },
        select: { userId: true },
      });
      const memberIds = new Set(members.map((member) => member.userId));
      if (memberIds.size !== new Set(data.memberIds).size) {
        throw new NotFoundException('One or more team members are not in the active organization');
      }
    }
    const team = await this.prisma.team.create({
      data: {
        organizationId: orgId,
        workspaceId: data.workspaceId,
        name: data.name,
        description: data.description,
      },
    });
    if (data.memberIds?.length) {
      await this.prisma.teamMember.createMany({
        data: data.memberIds.map((userId) => ({ teamId: team.id, userId })),
        skipDuplicates: true,
      });
    }
    return team;
  }

  private async assertWorkspaceInTenant(
    organizationId: string,
    workspaceId: string,
  ): Promise<void> {
    const workspace = await this.prisma.workspace.findFirst({
      where: { id: workspaceId, organizationId },
    });
    if (!workspace) throw new NotFoundException('Workspace not found in the active organization');
  }

  /** RBAC: org owners, admins, and managers manage org configuration. */
  private assertManager(user: AuthenticatedUser): void {
    if (!['OWNER', 'ADMIN', 'MANAGER'].includes(user.org?.role ?? '')) {
      throw new ForbiddenException('Insufficient role for this operation');
    }
  }

  private assertAdmin(user: AuthenticatedUser): void {
    if (!['OWNER', 'ADMIN'].includes(user.org?.role ?? '')) {
      throw new ForbiddenException('Only owners and administrators can update the organization');
    }
  }
}
