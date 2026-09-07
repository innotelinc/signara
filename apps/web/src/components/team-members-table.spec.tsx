import { renderToString } from 'react-dom/server';
import { TeamMembersTable } from './team-members-table';
import { mapMembers, type MembershipItem } from '@/lib/org-members';

/**
 * Regression guard for the Settings → Team crash. GET /api/v1/users returns
 * memberships with the user NESTED under `user`. The Team table used to read
 * flat `member.email`/`member.displayName`, which are undefined for that
 * shape, and `(displayName ?? email).slice(...)` then threw a client-side
 * exception ("Application error"). These tests pin the real payload shape and
 * the mapping the table depends on.
 */
const REAL_NESTED_PAYLOAD: {
  total: number;
  limit: number;
  offset: number;
  items: MembershipItem[];
} = {
  total: 2,
  limit: 50,
  offset: 0,
  items: [
    {
      id: 'ddaf37fe-89ec-4f1d-a56e-f158c4a57006',
      organizationId: '158e3c41-dcad-4072-9360-32424590fcc6',
      userId: 'af46fabd-34e4-4b0a-af59-a9379e23816e',
      role: 'OWNER',
      roleId: '3d6fdc38-7f5d-48bb-b02f-4255a042b80c',
      createdAt: '2026-09-07T18:51:46.331Z',
      user: {
        id: 'af46fabd-34e4-4b0a-af59-a9379e23816e',
        email: 'dhunter@innotel.us',
        displayName: 'Darnel Hunter',
        avatarUrl: null,
        lastLoginAt: '2026-09-07T19:01:33.301Z',
      },
    },
    {
      id: 'a1b2c3d4-0000-0000-0000-000000000001',
      organizationId: '158e3c41-dcad-4072-9360-32424590fcc6',
      userId: 'b2c3d4e5-0000-0000-0000-000000000002',
      role: 'MEMBER',
      roleId: '3d6fdc38-7f5d-48bb-b02f-4255a042b80c',
      createdAt: '2026-09-07T18:52:00.000Z',
      user: {
        id: 'b2c3d4e5-0000-0000-0000-000000000002',
        email: 'member@example.com',
        displayName: null,
        avatarUrl: null,
        lastLoginAt: null,
      },
    },
  ],
};

describe('mapMembers', () => {
  it('flattens the nested membership payload into renderable rows', () => {
    const rows = mapMembers(REAL_NESTED_PAYLOAD.items);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual({
      id: 'af46fabd-34e4-4b0a-af59-a9379e23816e',
      email: 'dhunter@innotel.us',
      displayName: 'Darnel Hunter',
      role: 'OWNER',
    });
    // Every row the table renders must have a defined email/displayName —
    // otherwise the avatar-initial slice crashes the Team tab.
    for (const row of rows) {
      expect(row.email).toBeDefined();
      expect(row.displayName).toBeDefined();
    }
  });
});

describe('TeamMembersTable', () => {
  it('renders every member from the real /users payload without throwing', () => {
    const members = mapMembers(REAL_NESTED_PAYLOAD.items);
    expect(() => renderToString(<TeamMembersTable members={members} />)).not.toThrow();
    const html = renderToString(<TeamMembersTable members={members} />);
    expect(html).toContain('Darnel Hunter');
    expect(html).toContain('dhunter@innotel.us');
    expect(html).toContain('member@example.com');
    expect(html).toContain('OWNER');
    expect(html).toContain('MEMBER');
  });

  it('shows the email for members without a display name (avatar fallback)', () => {
    const members = mapMembers(REAL_NESTED_PAYLOAD.items);
    const html = renderToString(<TeamMembersTable members={members} />);
    // Initial rendered from the email when displayName is null: "M".
    expect(html).toContain('>M</span>');
  });

  it('renders the empty state when there are no members', () => {
    const html = renderToString(<TeamMembersTable members={[]} />);
    expect(html).toContain('No members listed');
  });
});
