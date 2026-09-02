'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { FileText, Clock, CheckCircle2, FileSignature } from 'lucide-react';
import { api, ApiError } from '@/lib/api';
import { Badge, Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Spinner } from '@/components/ui/button';

interface RecentDocument {
  id: string;
  title: string;
  status: string;
  updatedAt: string;
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

export function Dashboard() {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [stats, setStats] = useState({ total: 0, awaiting: 0, completed: 0 });
  const [recent, setRecent] = useState<RecentDocument[]>([]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [user, documents] = await Promise.all([
          api.get<{ email: string; displayName: string | null; org?: { slug: string; role: string } }>('/api/v1/auth/me'),
          api.get<{ total: number; items: RecentDocument[] }>('/api/v1/documents?limit=8'),
        ]);
        if (cancelled) return;
        setStats({
          total: documents.total,
          awaiting: documents.items.filter((d) => d.status === 'AWAITING_SIGNATURE' || d.status === 'IN_PROGRESS').length,
          completed: documents.items.filter((d) => d.status === 'COMPLETED').length,
        });
        setRecent(documents.items);
        document.title = `${user.displayName ?? user.email} · Signara`;
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

  const statCards = [
    { label: 'Total documents', value: stats.total, icon: FileText },
    { label: 'Awaiting signature', value: stats.awaiting, icon: Clock },
    { label: 'Completed', value: stats.completed, icon: CheckCircle2 },
  ];

  return (
    <div>
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Dashboard</h1>
          <p className="text-sm text-slate-500">Overview of your documents and signing activity.</p>
        </div>
        <Link href="/documents" className="btn-primary">
          <FileSignature className="h-4 w-4" />
          Upload document
        </Link>
      </div>

      {error && (
        <div className="mb-6 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div>
      )}

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
            <p className="px-5 py-8 text-center text-sm text-slate-500">
              No documents yet. Upload your first PDF, DOCX, or image.
            </p>
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
                    <td className="td font-medium">{doc.title}</td>
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