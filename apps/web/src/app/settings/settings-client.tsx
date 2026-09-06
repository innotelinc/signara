'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  Building2,
  CreditCard,
  Save,
  ShieldCheck,
  UserRound,
  Users,
  KeyRound,
} from 'lucide-react';
import { api, ApiError } from '@/lib/api';
import { Badge, Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button, Spinner } from '@/components/ui/button';
import { cn } from '@/lib/cn';

interface Me {
  id: string;
  email: string;
  displayName: string | null;
  platformRole: 'USER' | 'PLATFORM_ADMIN';
  org?: { id: string; slug: string; role: string };
}

interface Org {
  id: string;
  name: string;
  slug: string;
  legalName?: string | null;
  taxId?: string | null;
  billingAccount?: { plan: string; status: string; seatsLimit: number | null; currentPeriodEnd: string | null } | null;
  _count?: { memberships: number; documents: number; workspaces: number };
}

interface Member {
  id: string;
  email: string;
  displayName?: string | null;
  role: string;
}

type Tab = 'profile' | 'organization' | 'team' | 'billing';

const TABS: { id: Tab; label: string; icon: typeof UserRound }[] = [
  { id: 'profile', label: 'Profile', icon: UserRound },
  { id: 'organization', label: 'Organization', icon: Building2 },
  { id: 'team', label: 'Team', icon: Users },
  { id: 'billing', label: 'Billing', icon: CreditCard },
];

export function Settings() {
  const [tab, setTab] = useState<Tab>('profile');
  const [me, setMe] = useState<Me | null>(null);
  const [org, setOrg] = useState<Org | null>(null);
  const [members, setMembers] = useState<Member[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState<string | null>(null);

  // Profile form state
  const [displayName, setDisplayName] = useState('');

  // Org form state
  const [orgName, setOrgName] = useState('');
  const [legalName, setLegalName] = useState('');
  const [taxId, setTaxId] = useState('');

  const load = useCallback(async () => {
    try {
      setError(null);
      const [meData, orgData] = await Promise.all([
        api.get<Me>('/api/v1/auth/me'),
        api.get<Org>('/api/v1/organizations/current'),
      ]);
      setMe(meData);
      setOrg(orgData);
      setDisplayName(meData.displayName ?? '');
      setOrgName(orgData.name ?? '');
      setLegalName(orgData.legalName ?? '');
      setTaxId(orgData.taxId ?? '');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to load settings');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const loadMembers = useCallback(async () => {
    try {
      const result = await api.get<{ total: number; items: Member[] }>('/api/v1/users?limit=50');
      setMembers(result.items);
    } catch {
      // Team tab may be permission-gated; leave the list empty.
    }
  }, []);

  useEffect(() => {
    if (tab === 'team') void loadMembers();
  }, [tab, loadMembers]);

  async function saveProfile() {
    setSaving(true);
    setSaved(null);
    try {
      await api.patch('/api/v1/users/me', { displayName });
      setSaved('Profile updated.');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to save profile');
    } finally {
      setSaving(false);
    }
  }

  async function saveOrg() {
    setSaving(true);
    setSaved(null);
    try {
      const updated = await api.patch<Org>('/api/v1/organizations/current', {
        name: orgName,
        legalName,
        taxId,
      });
      setOrg(updated);
      setSaved('Organization updated.');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to save organization');
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return (
      <div className="flex h-64 items-center justify-center">
        <Spinner className="h-8 w-8 text-primary-500" />
      </div>
    );
  }

  return (
    <div>
      <div className="mb-6">
        <h1 className="text-2xl font-semibold">Settings</h1>
        <p className="text-sm text-slate-500">Manage your profile, organization, team and billing.</p>
      </div>

      {error && (
        <div className="mb-6 flex items-center justify-between rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          <span>{error}</span>
          <button className="font-medium underline" onClick={() => { setError(null); void load(); }}>
            Dismiss
          </button>
        </div>
      )}

      {saved && (
        <div className="mb-6 flex items-center gap-2 rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-700">
          <Save className="h-4 w-4" />
          {saved}
        </div>
      )}

      <div className="flex flex-col gap-6 lg:flex-row">
        {/* Tab rail */}
        <nav className="flex shrink-0 gap-1 overflow-x-auto lg:w-52 lg:flex-col" aria-label="Settings sections">
          {TABS.map(({ id, label, icon: Icon }) => {
            const active = tab === id;
            return (
              <button
                key={id}
                type="button"
                onClick={() => setTab(id)}
                className={cn(
                  'flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium whitespace-nowrap transition-colors',
                  active ? 'bg-primary-500 text-white' : 'text-slate-600 hover:bg-slate-100',
                )}
                aria-current={active ? 'page' : undefined}
              >
                <Icon className="h-4 w-4" />
                {label}
              </button>
            );
          })}
        </nav>

        <div className="min-w-0 flex-1 space-y-6">
          {tab === 'profile' && (
            <Card>
              <CardHeader>
                <CardTitle>Profile</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="flex items-center gap-4 rounded-lg border border-slate-100 bg-slate-50 p-4">
                  <span className="flex h-12 w-12 items-center justify-center rounded-full bg-primary-500 text-base font-bold text-white">
                    {((displayName || me?.email) ?? '?').slice(0, 1).toUpperCase()}
                  </span>
                  <div>
                    <p className="font-semibold">{me?.displayName ?? 'Unnamed user'}</p>
                    <p className="text-sm text-slate-500">{me?.email}</p>
                    <Badge tone={me?.platformRole === 'PLATFORM_ADMIN' ? 'amber' : 'blue'}>
                      {me?.platformRole === 'PLATFORM_ADMIN' ? 'Platform admin' : 'Member'}
                    </Badge>
                  </div>
                </div>

                <div>
                  <label className="label" htmlFor="display-name">Display name</label>
                  <input
                    id="display-name"
                    className="input"
                    value={displayName}
                    onChange={(e) => setDisplayName(e.target.value)}
                    placeholder="Your full name"
                  />
                </div>
                <div>
                  <label className="label" htmlFor="email">Email</label>
                  <input id="email" className="input" value={me?.email ?? ''} disabled />
                  <p className="mt-1 text-xs text-slate-400">
                    Managed by Cerulean Authentik — change it in your identity provider.
                  </p>
                </div>

                <div className="flex items-center gap-2 rounded-lg border border-primary-100 bg-primary-50 px-4 py-3 text-sm text-primary-800">
                  <ShieldCheck className="h-4 w-4 shrink-0" />
                  Signed in through Cerulean SSO. Your identity and roles come from Authentik.
                </div>

                <div className="flex justify-end">
                  <Button onClick={() => void saveProfile()} loading={saving}>
                    <Save className="h-4 w-4" />
                    Save changes
                  </Button>
                </div>
              </CardContent>
            </Card>
          )}

          {tab === 'organization' && (
            <Card>
              <CardHeader>
                <CardTitle>Organization</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                {org && (
                  <div className="flex flex-wrap gap-4">
                    <div className="rounded-lg border border-slate-100 bg-slate-50 px-4 py-3">
                      <p className="text-xs text-slate-500">Slug</p>
                      <p className="font-semibold">{org.slug}</p>
                    </div>
                    <div className="rounded-lg border border-slate-100 bg-slate-50 px-4 py-3">
                      <p className="text-xs text-slate-500">Plan</p>
                      <p className="font-semibold capitalize">{org.billingAccount?.plan ?? 'Trial'}</p>
                    </div>
                    <div className="rounded-lg border border-slate-100 bg-slate-50 px-4 py-3">
                      <p className="text-xs text-slate-500">Members</p>
                      <p className="font-semibold">{org._count?.memberships ?? 0}</p>
                    </div>
                    <div className="rounded-lg border border-slate-100 bg-slate-50 px-4 py-3">
                      <p className="text-xs text-slate-500">Documents</p>
                      <p className="font-semibold">{org._count?.documents ?? 0}</p>
                    </div>
                  </div>
                )}

                <div>
                  <label className="label" htmlFor="org-name">Organization name</label>
                  <input
                    id="org-name"
                    className="input"
                    value={orgName}
                    onChange={(e) => setOrgName(e.target.value)}
                  />
                </div>
                <div>
                  <label className="label" htmlFor="legal-name">Legal name</label>
                  <input
                    id="legal-name"
                    className="input"
                    value={legalName}
                    onChange={(e) => setLegalName(e.target.value)}
                    placeholder="Registered legal entity name (optional)"
                  />
                </div>
                <div>
                  <label className="label" htmlFor="tax-id">Tax ID</label>
                  <input
                    id="tax-id"
                    className="input"
                    value={taxId}
                    onChange={(e) => setTaxId(e.target.value)}
                    placeholder="EIN / VAT number (optional)"
                  />
                </div>

                <div className="flex justify-end">
                  <Button onClick={() => void saveOrg()} loading={saving}>
                    <Save className="h-4 w-4" />
                    Save changes
                  </Button>
                </div>
              </CardContent>
            </Card>
          )}

          {tab === 'team' && (
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
          )}

          {tab === 'billing' && (
            <Card>
              <CardHeader>
                <CardTitle>Billing</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                {org?.billingAccount ? (
                  <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
                    <div className="rounded-lg border border-slate-100 bg-slate-50 px-4 py-3">
                      <p className="text-xs text-slate-500">Plan</p>
                      <p className="text-lg font-semibold capitalize">{org.billingAccount.plan}</p>
                    </div>
                    <div className="rounded-lg border border-slate-100 bg-slate-50 px-4 py-3">
                      <p className="text-xs text-slate-500">Status</p>
                      <p className="text-lg font-semibold capitalize">{org.billingAccount.status.toLowerCase()}</p>
                    </div>
                    <div className="rounded-lg border border-slate-100 bg-slate-50 px-4 py-3">
                      <p className="text-xs text-slate-500">Seats</p>
                      <p className="text-lg font-semibold">{org.billingAccount.seatsLimit ?? '—'}</p>
                    </div>
                  </div>
                ) : (
                  <div className="flex items-center gap-3 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
                    <KeyRound className="h-4 w-4 shrink-0" />
                    No billing account yet. Your organization is on the free trial plan.
                  </div>
                )}
                <p className="text-sm text-slate-500">
                  Invoices and usage details are managed per-organization. Contact your
                  organization administrator for plan changes.
                </p>
              </CardContent>
            </Card>
          )}
        </div>
      </div>
    </div>
  );
}