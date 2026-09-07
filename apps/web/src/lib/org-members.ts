/**
 * Organization member rows for the Settings → Team tab.
 *
 * GET /api/v1/users returns memberships with the user NESTED under `user`
 * ({ id, role, user: { id, email, displayName, ... } }). The UI renders flat
 * rows, and this mapping is the single place that translates between the two —
 * keep it in sync with the API contract (see users.service.ts listMembers).
 */

export interface OrgMember {
  id: string;
  email: string;
  displayName?: string | null;
  role: string;
}

/**
 * Raw shape returned by GET /api/v1/users: a membership with its nested user.
 * Only `id`/`role`/`user` drive the mapping; the rest mirror the API response.
 */
export interface MembershipItem {
  id: string;
  role: string;
  organizationId?: string;
  userId?: string;
  roleId?: string;
  createdAt?: string;
  user: {
    id: string;
    email: string;
    displayName: string | null;
    avatarUrl?: string | null;
    lastLoginAt?: string | null;
  };
}

export function mapMembers(items: MembershipItem[]): OrgMember[] {
  return items.map((m) => ({
    id: m.user.id,
    email: m.user.email,
    displayName: m.user.displayName,
    role: m.role,
  }));
}
