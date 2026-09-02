'use client';

import { useCallback, useEffect, useState } from 'react';
import { FileText, ShieldCheck } from 'lucide-react';
import { api, ApiError } from '@/lib/api';
import { Badge, Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button, Spinner } from '@/components/ui/button';

interface SigningSession {
  requestId: string;
  title: string;
  message: string | null;
  deadline: string | null;
  mode: 'SEQUENTIAL' | 'PARALLEL';
  allowsSigning: boolean;
  document: { id: string; fileName: string; downloadUrl: string };
  signer: { id: string; email: string; name: string | null; role: 'SIGNER' | 'APPROVER' | 'CC'; status: string };
  requestedFields: unknown[];
}

/**
 * Public signing room. The URL token is the credential — this page performs
 * no authentication itself; the API resolves and records the session.
 */
export function SigningRoom({ token }: { token: string }) {
  const [session, setSession] = useState<SigningSession | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [action, setAction] = useState<'sign' | 'decline' | null>(null);
  const [done, setDone] = useState(false);

  const load = useCallback(async () => {
    try {
      const data = await api.get<SigningSession>(`/api/v1/signatures/public/${encodeURIComponent(token)}`);
      setSession(data);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Unable to open signing session');
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => {
    void load();
  }, [load]);

  async function sign() {
    setAction('sign');
    try {
      await api.post(`/api/v1/signatures/public/${encodeURIComponent(token)}/sign`, { type: 'TYPED' });
      setDone(true);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to record signature');
    } finally {
      setAction(null);
    }
  }

  async function decline() {
    setAction('decline');
    try {
      await api.post(`/api/v1/signatures/public/${encodeURIComponent(token)}/decline`, {});
      setDone(true);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to record decline');
    } finally {
      setAction(null);
    }
  }

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-slate-50">
        <Spinner className="h-8 w-8 text-primary-500" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-slate-50 px-4">
        <Card className="w-full max-w-md">
          <CardContent className="py-10 text-center">
            <p className="text-sm text-red-600">{error}</p>
          </CardContent>
        </Card>
      </div>
    );
  }

  if (done || !session) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-slate-50 px-4">
        <Card className="w-full max-w-md">
          <CardContent className="py-10 text-center">
            <ShieldCheck className="mx-auto mb-4 h-12 w-12 text-accent-500" />
            <h1 className="text-xl font-semibold">Thank you</h1>
            <p className="mt-2 text-sm text-slate-500">
              Your response has been recorded. A signed copy and the audit trail are available from the sender.
            </p>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-50 px-4 py-10">
      <Card className="w-full max-w-lg">
        <CardHeader>
          <div className="flex items-center gap-3">
            <span className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary-50">
              <FileText className="h-5 w-5 text-primary-600" />
            </span>
            <div>
              <CardTitle>{session.title}</CardTitle>
              <p className="text-xs text-slate-500">
                For {session.signer.name ?? session.signer.email} · {session.signer.role}
              </p>
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          {session.signer.status === 'SIGNED' ? (
            <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-700">
              You have already signed this document.
            </div>
          ) : (
            <>
              {session.allowsSigning ? null : (
                <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-700">
                  This request is in sequential order — you can review, but signing unlocks once it is your turn.
                </div>
              )}
              {session.message && (
                <blockquote className="rounded-lg border-l-4 border-primary-500 bg-slate-50 px-4 py-3 text-sm text-slate-600">
                  {session.message}
                </blockquote>
              )}
              {session.deadline && (
                <p className="text-xs text-slate-500">Deadline: {new Date(session.deadline).toLocaleString()}</p>
              )}
              <div className="flex items-center justify-between rounded-lg border border-slate-200 px-4 py-3">
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium">{session.document.fileName}</p>
                  <p className="text-xs text-slate-500">PDF · securely stored by the sender</p>
                </div>
                <a href={session.document.downloadUrl} target="_blank" rel="noreferrer" className="btn-outline">
                  View
                </a>
              </div>
              <div className="flex items-center justify-between gap-3 pt-2">
                <Button variant="danger" onClick={decline} loading={action === 'decline'} disabled={action === 'sign'}>
                  Decline
                </Button>
                <Button onClick={sign} loading={action === 'sign'} disabled={action === 'decline' || !session.allowsSigning}>
                  Sign document
                </Button>
              </div>
            </>
          )}
          <div className="flex items-center gap-2 pt-2 text-xs text-slate-400">
            <ShieldCheck className="h-4 w-4" />
            Your IP address, timestamp, and browser are recorded to the audit trail. Powered by Signara.
          </div>
        </CardContent>
      </Card>
    </div>
  );
}