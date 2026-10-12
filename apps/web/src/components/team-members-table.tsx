'use client';

import { Trash2 } from 'lucide-react';
import type { OrgMember } from '@/lib/org-members';
import { Badge, Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

interface TeamMembersTableProps {
  members: OrgMember[];
  /** Provided only for callers allowed to manage members (OWNER/ADMIN). */
  onRemove?: (member: OrgMember) => void;
  /** Membership id currently being removed, so its button shows as busy. */
  removingId?: string | null;
}

export function TeamMembersTable({ members, onRemove, removingId }: TeamMembersTableProps) {
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
                {onRemove && <th className="th text-right">Actions</th>}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {members.map((member) => (
                <tr key={member.membershipId} className="hover:bg-slate-50">
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
                  {onRemove && (
                    <td className="td text-right">
                      {member.role === 'OWNER' ? (
                        // The API refuses to remove the organization owner, so don't
                        // offer an action that can only fail.
                        <span className="text-xs text-slate-400">Owner</span>
                      ) : (
                        <button
                          type="button"
                          onClick={() => onRemove(member)}
                          disabled={removingId === member.membershipId}
                          aria-label={`Remove ${member.displayName ?? member.email}`}
                          className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium text-red-600 transition-colors hover:bg-red-50 disabled:opacity-50"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                          {removingId === member.membershipId ? 'Removing…' : 'Remove'}
                        </button>
                      )}
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </CardContent>
    </Card>
  );
}
