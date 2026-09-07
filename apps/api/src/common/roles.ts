import { MembershipRole } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Seeded system Role granted for each MembershipRole. The membership's
 * `roleId` must point at one of these for RBAC permissions to resolve
 * (`user.org.permissions` is read from `roleRef.permissions`).
 */
export const SYSTEM_ROLE_BY_MEMBERSHIP_ROLE: Record<MembershipRole, string> = {
  OWNER: 'ORGANIZATION_OWNER',
  ADMIN: 'ADMINISTRATOR',
  MANAGER: 'MANAGER',
  AUDITOR: 'AUDITOR',
  MEMBER: 'USER',
};

/** Resolves the seeded system Role id backing a MembershipRole (null if the
 * Role rows have not been seeded — falls back to today's no-permission
 * behaviour rather than failing). */
export async function resolveSystemRoleId(
  prisma: PrismaService,
  role: MembershipRole,
): Promise<string | null> {
  const systemRole = await prisma.role.findUnique({
    where: { name: SYSTEM_ROLE_BY_MEMBERSHIP_ROLE[role] },
    select: { id: true },
  });
  return systemRole?.id ?? null;
}
