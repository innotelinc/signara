'use client';

import type { OrgMember } from '@/lib/org-members';
import { Badge, Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

export function TeamMembersTable({ members }: { members: OrgMember[] }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Team</CardTitle>
      </CardHeader>
      <CardContent className="px-0">
        {members.length === 0 ? (
          <p className="px-5 py-8 text-center text-sm text-slate-500">
            No members listed. Invite teammates to collaborate on documents.
          </p>
        ) : (
          <table className="w-full">
            <thead className="border-b border-slate-200">
              <tr>
                <th className="th">Member</th>
                <th className="th">Role</th>
                <th className="th">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {members.map((member) => (
                <tr key={member.id} className="hover:bg-slate-50">
                  <td className="td">
                    <div className="flex items-center gap-3">
                      <span className="flex h-8 w-8 items-center justify-center rounded-full bg-primary-100 text-xs font-bold text-primary-700">
                        {(member.displayName ?? member.email).slice(0, 1).toUpperCase()}
                      </span>
                      <div>
                        <p className="font-medium">{member.displayName ?? '—'}</p>
                        <p className="text-xs text-slate-500">{member.email}</p>
                      </div>
                    </div>
                  </td>
                  <td className="td">
                    <Badge tone={member.role === 'OWNER' ? 'amber' : 'blue'}>{member.role}</Badge>
                  </td>
                  <td className="td">
                    <Badge tone="green">Active</Badge>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </CardContent>
    </Card>
  );
}
