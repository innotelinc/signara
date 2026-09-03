import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { MembershipRole } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { AuthenticatedUser } from '../../common/types';

@Injectable()
export class UsersService {
  constructor(private readonly prisma: PrismaService) {}

  async updateProfile(
    user: AuthenticatedUser,
    data: { displayName?: string; timezone?: string; locale?: string },
  ) {
    return this.prisma.user.update({
      where: { id: user.id },
      data: {
        displayName: data.displayName,
        timezone: data.timezone,
        locale: data.locale,
      },
      select: {
        id: true,
        email: true,
        displayName: true,
        firstName: true,
        lastName: true,
        avatarUrl: true,
        timezone: true,
        locale: true,
      },
    });
  }

  /** All members of the caller's active organization. */
  async listMembers(
    user: AuthenticatedUser,
    query: { search?: string; role?: MembershipRole; limit?: number; offset?: number },
  ) {
    const orgId = user.org?.id;
    if (!orgId) throw new ForbiddenException('No active tenant');

    const limit = Math.min(query.limit ?? 50, 200);
    const where = {
      organizationId: orgId,
      ...(query.role ? { role: query.role } : {}),
      ...(query.search
        ? {
            user: {
              OR: [
                { email: { contains: query.search, mode: 'insensitive' as const } },
                { displayName: { contains: query.search, mode: 'insensitive' as const } },
              ],
            },
          }
        : {}),
    };

    const [total, members] = await this.prisma.$transaction([
      this.prisma.membership.count({ where }),
      this.prisma.membership.findMany({
        where,
        include: {
          user: {
            select: {
              id: true,
              email: true,
              displayName: true,
              avatarUrl: true,
              lastLoginAt: true,
            },
          },
        },
        orderBy: { createdAt: 'asc' },
        skip: query.offset ?? 0,
        take: limit,
      }),
    ]);

    return { total, limit, offset: query.offset ?? 0, items: members };
  }

  /** Invites a user by email with a role; idempotent per (org, email). */
  async inviteMember(
    user: AuthenticatedUser,
    data: { email: string; role: MembershipRole; workspaceIds?: string[] },
  ) {
    const orgId = user.org?.id;
    if (!orgId) throw new ForbiddenException('No active tenant');

    const email = data.email.toLowerCase().trim();
    if (!email.includes('@')) throw new BadRequestException('Invalid email address');

    const existing = await this.prisma.membership.findFirst({
      where: { organizationId: orgId, user: { email } },
      include: { user: true },
    });
    if (existing) throw new ConflictException('User is already a member');

    if (data.workspaceIds?.length) {
      const workspaces = await this.prisma.workspace.findMany({
        where: { organizationId: orgId, id: { in: data.workspaceIds } },
        select: { id: true },
      });
      if (workspaces.length !== new Set(data.workspaceIds).size) {
        throw new NotFoundException('One or more workspaces are not in the active organization');
      }
    }

    let memberUser = await this.prisma.user.findUnique({ where: { email } });
    if (!memberUser) {
      memberUser = await this.prisma.user.create({
        data: { email, status: 'INVITED', authProvider: 'authentik' },
      });
    }

    const membership = await this.prisma.membership.create({
      data: { organizationId: orgId, userId: memberUser.id, role: data.role },
    });

    if (data.workspaceIds?.length) {
      await this.prisma.workspaceMember.createMany({
        data: data.workspaceIds.map((workspaceId) => ({ workspaceId, userId: memberUser!.id })),
        skipDuplicates: true,
      });
    }

    // TODO(notifications): enqueue invitation email on the notifications queue
    return { id: membership.id, email, role: data.role, status: memberUser.status };
  }

  /** Updates another member's role (caller must be OWNER/ADMIN). */
  async updateMemberRole(user: AuthenticatedUser, memberId: string, role: MembershipRole) {
    const orgId = user.org?.id;
    if (!orgId) throw new ForbiddenException('No active tenant');
    this.assertCanManage(user, orgId);

    return this.prisma.membership.update({
      where: { id: memberId, organizationId: orgId },
      data: { role },
    });
  }

  /** Removes a member from the organization. */
  async removeMember(user: AuthenticatedUser, memberId: string) {
    const orgId = user.org?.id;
    if (!orgId) throw new ForbiddenException('No active tenant');
    this.assertCanManage(user, orgId);

    const membership = await this.prisma.membership.findUnique({ where: { id: memberId } });
    if (!membership || membership.organizationId !== orgId)
      throw new NotFoundException('Member not found');
    if (membership.role === 'OWNER')
      throw new BadRequestException('Cannot remove the organization owner');

    await this.prisma.membership.delete({ where: { id: memberId } });
    return { success: true };
  }

  /** Guards: only OWNER/ADMIN roles manage members. */
  private assertCanManage(user: AuthenticatedUser, orgId: string): void {
    const role = user.org?.role;
    if (role !== 'OWNER' && role !== 'ADMIN') {
      throw new ForbiddenException(
        'Only organization owners and administrators can manage members',
      );
    }
  }
}
