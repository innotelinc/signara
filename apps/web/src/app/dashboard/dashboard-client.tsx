'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import {
  FileText,
  Clock,
  CheckCircle2,
  FileSignature,
  FolderUp,
  LayoutTemplate,
  ShieldCheck,
} from 'lucide-react';
import { api, ApiError } from '@/lib/api';
import { Badge, Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button, Spinner } from '@/components/ui/button';

interface RecentDocument {
  id: string;
  title: string;
  status: string;
  updatedAt: string;
}

interface Me {
  email: string;
  displayName: string | null;
  org?: { slug: string };
}

const STATUS_TONE: Record<string, 'gray' | 'green' | 'blue' | 'amber' | 'red'> = {
  DRAFT: 'gray',
  AWAITING_SIGNATURE: 'blue',
  IN_PROGRESS: 'amber',
  COMPLETED: 'green',
  VOIDED: 'red',
  CANCELLED: 'red',
  EXPIRED: 'red',
};

const QUICK_ACTIONS = [
  { href: '/documents', label: 'Upload document', icon: FolderUp },
  { href: '/templates', label: 'Create template', icon: LayoutTemplate },
  { href: '/settings', label: 'Manage settings', icon: ShieldCheck },
];

/** First-run state: the signed-in user belongs to no organization yet. */
function Onboarding() {
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function createOrganization() {
    setBusy(true);
    setError(null);
    try {
      await api.post('/api/v1/organizations', { name });
      // Reload so the freshly-resolved tenant context flows through the app.
      window.location.reload();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to create organization');
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto max-w-lg">
      <Card>
        <CardHeader>
          <CardTitle>Create your organization</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-sm text-slate-500">
            You&apos;re signed in but not part of an organization yet. Create one to start
            uploading documents and sending signing requests.
          </p>
          <div>
            <label className="label" htmlFor="org-name">Organization name</label>
            <input
              id="org-name"
              className="input"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Acme Corp"
              autoFocus
            />
          </div>
          {error && (
            <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
              {error}
            </div>
          )}
          <div className="flex justify-end">
            <Button onClick={() => void createOrganization()} loading={busy} disabled={name.trim().length < 2}>
              Create organization
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

export function Dashboard() {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [me, setMe] = useState<Me | null>(null);
  const [stats, setStats] = useState({ total: 0, awaiting: 0, completed: 0 });
  const [recent, setRecent] = useState<RecentDocument[]>([]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const user = await api.get<Me>('/api/v1/auth/me');
        if (cancelled) return;
        setMe(user);
        document.title = `${user.displayName ?? user.email} · Signara`;
        // Without a tenant the tenant-scoped document call would only 403.
        if (user.org) {
          const documents = await api.get<{ total: number; items: RecentDocument[] }>(
            '/api/v1/documents?limit=8',
          );
          if (cancelled) return;
          setStats({
            total: documents.total,
            awaiting: documents.items.filter((d) => d.status === 'AWAITING_SIGNATURE' || d.status === 'IN_PROGRESS').length,
            completed: documents.items.filter((d) => d.status === 'COMPLETED').length,
          });
          setRecent(documents.items);
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof ApiError ? err.message : 'Failed to load dashboard');
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  if (loading) {
    return (
      <div className="flex h-64 items-center justify-center">
        <Spinner className="h-8 w-8 text-primary-500" />
      </div>
    );
  }

  // First-run onboarding gate.
  if (me && !me.org) {
    return <Onboarding />;
  }

  const statCards = [
    { label: 'Total documents', value: stats.total, icon: FileText },
    { label: 'Awaiting signature', value: stats.awaiting, icon: Clock },
    { label: 'Completed', value: stats.completed, icon: CheckCircle2 },
  ];

  const firstName = (me?.displayName ?? me?.email ?? '').split(/\s+/)[0] || 'there';

  return (
    <div>
      <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">Welcome back, {firstName}.</h1>
          <p className="mt-1 text-sm text-slate-500">
            Overview of your documents and signing activity
            {me?.org ? (
              <>
                {' '}in <span className="font-medium text-slate-700">{me.org.slug}</span>
              </>
            ) : null}
            .
          </p>
        </div>
        <Link href="/documents" className="btn-primary">
          <FileSignature className="h-4 w-4" />
          Upload document
        </Link>
      </div>

      {error && (
        <div className="mb-6 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div>
      )}

      {/* Quick actions */}
      <div className="mb-6 grid grid-cols-1 gap-4 sm:grid-cols-3">
        {QUICK_ACTIONS.map(({ href, label, icon: Icon }) => (
          <Link
            key={href}
            href={href}
            className="flex items-center gap-4 rounded-xl border border-slate-200 bg-white px-5 py-4 shadow-sm transition-all hover:-translate-y-0.5 hover:border-primary-200 hover:shadow-md"
          >
            <span className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary-50">
              <Icon className="h-5 w-5 text-primary-600" />
            </span>
            <span className="text-sm font-semibold">{label}</span>
          </Link>
        ))}
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        {statCards.map(({ label, value, icon: Icon }) => (
          <Card key={label}>
            <CardContent className="flex items-center gap-4">
              <span className="flex h-11 w-11 items-center justify-center rounded-lg bg-primary-50">
                <Icon className="h-5 w-5 text-primary-600" />
              </span>
              <div>
                <p className="text-2xl font-semibold">{value}</p>
                <p className="text-sm text-slate-500">{label}</p>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      <Card className="mt-6">
        <CardHeader>
          <CardTitle>Recent documents</CardTitle>
        </CardHeader>
        <CardContent className="px-0">
          {recent.length === 0 ? (
            <div className="px-5 py-10 text-center">
              <FileSignature className="mx-auto mb-3 h-8 w-8 text-slate-300" />
              <p className="text-sm text-slate-500">
                No documents yet. Upload your first PDF, DOCX, or image to get started.
              </p>
              <Link href="/documents" className="btn-primary mt-4">
                Upload your first document
              </Link>
            </div>
          ) : (
            <table className="w-full">
              <thead className="border-b border-slate-200">
                <tr>
                  <th className="th">Title</th>
                  <th className="th">Status</th>
                  <th className="th">Updated</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {recent.map((doc) => (
                  <tr key={doc.id} className="hover:bg-slate-50">
                    <td className="td">
                      <Link href={`/documents/${doc.id}`} className="font-medium hover:text-primary-700">
                        {doc.title}
                      </Link>
                    </td>
                    <td className="td">
                      <Badge tone={STATUS_TONE[doc.status] ?? 'gray'}>{doc.status.replaceAll('_', ' ')}</Badge>
                    </td>
                    <td className="td text-slate-500">{new Date(doc.updatedAt).toLocaleDateString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}