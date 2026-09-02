'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { ArrowLeft, ArrowRight, Check, Mail, Plus, Send, Trash2, UserPlus, Users } from 'lucide-react';
import { api, ApiError } from '@/lib/api';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import type { CreatedSigningRequest, DocumentDetail, SignerDraft, SignerRole } from '@/lib/types';

type Step = 'signers' | 'settings' | 'review';

const ROLE_LABEL: Record<SignerRole, string> = {
  SIGNER: 'Signer',
  APPROVER: 'Approver',
  CC: 'CC (copy)',
};

export function SendWizardClient({ documentId }: { documentId: string }) {
  const [doc, setDoc] = useState<DocumentDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [step, setStep] = useState<Step>('signers');
  const [signers, setSigners] = useState<SignerDraft[]>([]);
  const [mode, setMode] = useState<'SEQUENTIAL' | 'PARALLEL'>('SEQUENTIAL');
  const [message, setMessage] = useState('');
  const [deadline, setDeadline] = useState('');
  const [title, setTitle] = useState('');
  const [sending, setSending] = useState(false);
  const [created, setCreated] = useState<CreatedSigningRequest | null>(null);
  const [draftEmail, setDraftEmail] = useState('');
  const [draftName, setDraftName] = useState('');
  const [draftRole, setDraftRole] = useState<SignerRole>('SIGNER');
  const [draftError, setDraftError] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const result = await api.get<DocumentDetail>(`/api/v1/documents/${documentId}`);
        setDoc(result);
        setTitle(result.title);
      } catch (err) {
        setError(err instanceof ApiError ? err.message : 'Failed to load document');
      } finally {
        setLoading(false);
      }
    })();
  }, [documentId]);

  const addSigner = () => {
    const email = draftEmail.trim().toLowerCase();
    if (!email) {
      setDraftError('Email is required');
      return;
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      setDraftError('Enter a valid email address');
      return;
    }
    if (signers.some((s) => s.email === email)) {
      setDraftError('This email is already in the list');
      return;
    }
    if (signers.length >= 50) {
      setDraftError('A signing request supports at most 50 signers');
      return;
    }
    setSigners((prev) => [...prev, { email, name: draftName.trim() || undefined, role: draftRole, orderIndex: prev.length }]);
    setDraftEmail('');
    setDraftName('');
    setDraftRole('SIGNER');
    setDraftError(null);
  };

  const removeSigner = (email: string) => {
    setSigners((prev) => prev.filter((s) => s.email !== email).map((s, i) => ({ ...s, orderIndex: i })));
  };

  const moveSigner = (index: number, delta: -1 | 1) => {
    setSigners((prev) => {
      const next = [...prev];
      const target = index + delta;
      if (target < 0 || target >= next.length) return prev;
      [next[index], next[target]] = [next[target], next[index]];
      return next.map((s, i) => ({ ...s, orderIndex: i }));
    });
  };

  const sequentialOrder = useMemo(() => [...signers].sort((a, b) => a.orderIndex - b.orderIndex), [signers]);

  const canContinue = useMemo(() => {
    if (signers.length === 0) return false;
    return signers.length === new Set(signers.map((s) => s.email)).size;
  }, [signers]);

  async function submit() {
    setSending(true);
    setError(null);
    try {
      const result = await api.post<CreatedSigningRequest>('/api/v1/signatures/requests', {
        documentId,
        title: title.trim() || undefined,
        message: message.trim() || undefined,
        deadline: deadline ? new Date(deadline).toISOString() : undefined,
        mode,
        signers: signers.map((s) => ({ email: s.email, name: s.name, role: s.role, orderIndex: s.orderIndex })),
        sendInvites: true,
      });
      setCreated(result);
      setStep('review');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to send signing request');
    } finally {
      setSending(false);
    }
  }

  if (loading) {
    return (
      <div className="flex h-64 items-center justify-center">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-primary-500 border-t-transparent" />
      </div>
    );
  }

  // Success state
  if (created) {
    return (
      <div className="mx-auto max-w-xl">
        <Card>
          <CardContent className="flex flex-col items-center py-12 text-center">
            <span className="mb-4 flex h-14 w-14 items-center justify-center rounded-full bg-emerald-50">
              <Check className="h-7 w-7 text-emerald-600" />
            </span>
            <h1 className="text-xl font-semibold">Request sent!</h1>
            <p className="mt-2 text-sm text-slate-500">
              {created.signers.filter((s) => s.role !== 'CC').length} signer(s) invited to{' '}
              <strong>{created.signers[0]?.email}</strong>
              {created.signers.length > 1 ? ` and ${created.signers.length - 1} more` : ''} via email.
            </p>
            <div className="mt-6 grid w-full grid-cols-2 gap-3 text-left">
              <div className="rounded-lg border border-slate-200 p-4">
                <p className="text-xs uppercase tracking-wide text-slate-400">Mode</p>
                <p className="mt-1 font-medium capitalize">{created.mode.toLowerCase()}</p>
              </div>
              <div className="rounded-lg border border-slate-200 p-4">
                <p className="text-xs uppercase tracking-wide text-slate-400">Status</p>
                <p className="mt-1 font-medium">{created.status.replaceAll('_', ' ')}</p>
              </div>
            </div>
            <div className="mt-8 flex gap-3">
              <Link href={`/documents/${doc?.id}`} className="btn-outline">
                <ArrowLeft className="h-4 w-4" />
                Back to document
              </Link>
              <Link href="/documents" className="btn-primary">
                View documents
              </Link>
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

  if (!doc) {
    return (
      <div>
        <p className="text-sm text-slate-500">{error ?? 'Document not found.'}</p>
        <Link href="/documents" className="btn-outline mt-4">
          Back to documents
        </Link>
      </div>
    );
  }

  const steps: Array<{ id: Step; label: string }> = [
    { id: 'signers', label: 'Recipients' },
    { id: 'settings', label: 'Options' },
    { id: 'review', label: 'Review & send' },
  ];

  return (
    <div className="mx-auto max-w-3xl">
      <Link
        href={`/documents/${doc.id}`}
        className="mb-4 inline-flex items-center gap-1 text-sm text-slate-500 hover:text-slate-700"
      >
        <ArrowLeft className="h-4 w-4" />
        Back to document
      </Link>

      <div className="mb-6">
        <h1 className="text-2xl font-semibold">Send for signature</h1>
        <p className="text-sm text-slate-500">
          <strong>{doc.title}</strong> · {doc.fileName}
        </p>
      </div>

      {/* Stepper */}
      <ol className="mb-8 flex items-center gap-2 text-sm" aria-label="Wizard steps">
        {steps.map((s, i) => {
          const active = s.id === step;
          const done = (active ? steps.findIndex((x) => x.id === step) : i) < steps.findIndex((x) => x.id === step);
          return (
            <li key={s.id} className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => {
                  if (i <= steps.findIndex((x) => x.id === step)) setStep(s.id);
                }}
                className={`flex items-center gap-2 rounded-full px-3 py-1 font-medium ${
                  active ? 'bg-primary-500 text-white' : done ? 'text-primary-600' : 'text-slate-500'
                }`}
              >
                <span
                  className={`flex h-5 w-5 items-center justify-center rounded-full text-xs ${
                    active ? 'bg-white/20' : done ? 'bg-primary-100' : 'bg-slate-200'
                  }`}
                >
                  {done ? <Check className="h-3 w-3" /> : i + 1}
                </span>
                {s.label}
              </button>
              {i < steps.length - 1 && <span className="h-px w-6 bg-slate-300" />}
            </li>
          );
        })}
      </ol>

      {error && (
        <div className="mb-6 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div>
      )}

      {step === 'signers' && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Users className="h-4 w-4" />
              Recipients
            </CardTitle>
            <CardDescription>Add everyone who needs to sign, approve, or receive a copy.</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="mb-4 grid grid-cols-1 gap-3 rounded-lg border border-slate-200 bg-slate-50 p-4 sm:grid-cols-[1fr_1fr_auto_auto]">
              <input
                className="input"
                placeholder="Email address"
                type="email"
                value={draftEmail}
                onChange={(e) => setDraftEmail(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && (e.preventDefault(), addSigner())}
                aria-label="Signer email"
              />
              <input
                className="input"
                placeholder="Full name (optional)"
                value={draftName}
                onChange={(e) => setDraftName(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && (e.preventDefault(), addSigner())}
                aria-label="Signer name"
              />
              <select
                className="input sm:w-36"
                value={draftRole}
                onChange={(e) => setDraftRole(e.target.value as SignerRole)}
                aria-label="Role"
              >
                {(Object.keys(ROLE_LABEL) as SignerRole[]).map((role) => (
                  <option key={role} value={role}>
                    {ROLE_LABEL[role]}
                  </option>
                ))}
              </select>
              <Button variant="outline" onClick={addSigner}>
                <UserPlus className="h-4 w-4" />
                Add
              </Button>
            </div>
            {draftError && <p className="mb-3 text-sm text-red-600">{draftError}</p>}

            {signers.length === 0 ? (
              <p className="py-8 text-center text-sm text-slate-500">
                No recipients yet — add the first email above to begin.
              </p>
            ) : (
              <ul className="divide-y divide-slate-100">
                {signers.map((signer, index) => (
                  <li key={signer.email} className="flex items-center gap-3 py-3">
                    <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-primary-50 text-sm font-semibold text-primary-700">
                      {index + 1}
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="truncate font-medium">
                        {signer.name ? `${signer.name} ` : ''}
                        <span className="font-normal text-slate-500">{signer.email}</span>
                      </p>
                      <p className="text-xs text-slate-400">{ROLE_LABEL[signer.role]}</p>
                    </div>
                    <div className="flex items-center gap-1">
                      <Button variant="ghost" size="sm" onClick={() => moveSigner(index, -1)} disabled={index === 0} aria-label="Move up">
                        ↑
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => moveSigner(index, 1)}
                        disabled={index === signers.length - 1}
                        aria-label="Move down"
                      >
                        ↓
                      </Button>
                      <Button variant="ghost" size="sm" onClick={() => removeSigner(signer.email)} aria-label="Remove">
                        <Trash2 className="h-4 w-4 text-red-500" />
                      </Button>
                    </div>
                  </li>
                ))}
              </ul>
            )}

            <div className="mt-6 flex justify-end">
              <Button onClick={() => setStep('settings')} disabled={!canContinue}>
                Next: Options
                <ArrowRight className="h-4 w-4" />
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {step === 'settings' && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Mail className="h-4 w-4" />
              Options
            </CardTitle>
            <CardDescription>Signing order, message, and deadline.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-5">
            <div>
              <span className="label">Signing order</span>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <label
                  className={`flex cursor-pointer items-start gap-3 rounded-lg border p-4 ${
                    mode === 'SEQUENTIAL' ? 'border-primary-500 bg-primary-50' : 'border-slate-200'
                  }`}
                >
                  <input
                    type="radio"
                    name="mode"
                    className="mt-1"
                    checked={mode === 'SEQUENTIAL'}
                    onChange={() => setMode('SEQUENTIAL')}
                  />
                  <div>
                    <p className="font-medium">Sequential</p>
                    <p className="text-sm text-slate-500">
                      Each recipient signs in turn — recommended for contracts. Others are released one at a time.
                    </p>
                  </div>
                </label>
                <label
                  className={`flex cursor-pointer items-start gap-3 rounded-lg border p-4 ${
                    mode === 'PARALLEL' ? 'border-primary-500 bg-primary-50' : 'border-slate-200'
                  }`}
                >
                  <input
                    type="radio"
                    name="mode"
                    className="mt-1"
                    checked={mode === 'PARALLEL'}
                    onChange={() => setMode('PARALLEL')}
                  />
                  <div>
                    <p className="font-medium">Parallel</p>
                    <p className="text-sm text-slate-500">Everyone can sign at the same time — fastest for internal approvals.</p>
                  </div>
                </label>
              </div>
            </div>

            <div>
              <label className="label" htmlFor="wizard-title">
                Request title
              </label>
              <input id="wizard-title" className="input" value={title} onChange={(e) => setTitle(e.target.value)} />
            </div>

            <div>
              <label className="label" htmlFor="wizard-message">
                Message to recipients
              </label>
              <textarea
                id="wizard-message"
                className="input"
                rows={3}
                placeholder="Optional note shown with the signing link…"
                value={message}
                onChange={(e) => setMessage(e.target.value)}
              />
            </div>

            <div>
              <label className="label" htmlFor="wizard-deadline">
                Deadline (optional)
              </label>
              <input
                id="wizard-deadline"
                type="datetime-local"
                className="input sm:max-w-xs"
                value={deadline}
                onChange={(e) => setDeadline(e.target.value)}
              />
            </div>

            <div className="flex justify-between">
              <Button variant="outline" onClick={() => setStep('signers')}>
                <ArrowLeft className="h-4 w-4" />
                Back
              </Button>
              <Button onClick={() => setStep('review')}>
                Review
                <ArrowRight className="h-4 w-4" />
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {step === 'review' && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Send className="h-4 w-4" />
              Review &amp; send
            </CardTitle>
            <CardDescription>Confirm the recipients and options below, then send.</CardDescription>
          </CardHeader>
          <CardContent>
            <dl className="space-y-3 rounded-lg border border-slate-200 bg-slate-50 p-4 text-sm">
              <div className="flex justify-between gap-4">
                <dt className="text-slate-500">Document</dt>
                <dd className="font-medium">{doc.title}</dd>
              </div>
              <div className="flex justify-between gap-4">
                <dt className="text-slate-500">Mode</dt>
                <dd className="font-medium capitalize">{mode.toLowerCase()}</dd>
              </div>
              {title && (
                <div className="flex justify-between gap-4">
                  <dt className="text-slate-500">Request title</dt>
                  <dd className="font-medium">{title}</dd>
                </div>
              )}
              {deadline && (
                <div className="flex justify-between gap-4">
                  <dt className="text-slate-500">Deadline</dt>
                  <dd className="font-medium">{new Date(deadline).toLocaleString()}</dd>
                </div>
              )}
            </dl>

            <div className="mt-4">
              <p className="label">Recipients ({sequentialOrder.length})</p>
              <table className="w-full">
                <thead className="border-b border-slate-200">
                  <tr>
                    <th className="th">#</th>
                    <th className="th">Email</th>
                    <th className="th">Name</th>
                    <th className="th">Role</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {sequentialOrder.map((signer, i) => (
                    <tr key={signer.email}>
                      <td className="td text-slate-500">{i + 1}</td>
                      <td className="td font-medium">{signer.email}</td>
                      <td className="td text-slate-500">{signer.name ?? '—'}</td>
                      <td className="td">
                        <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-700">
                          {ROLE_LABEL[signer.role]}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="mt-6 flex justify-between">
              <Button variant="outline" onClick={() => setStep('settings')}>
                <ArrowLeft className="h-4 w-4" />
                Back
              </Button>
              <Button onClick={() => void submit()} loading={sending}>
                <Send className="h-4 w-4" />
                Send signing request
              </Button>
            </div>
            <div className="mt-4 flex items-center gap-2 text-xs text-slate-400">
              <Plus className="h-3 w-3" />
              Each recipient receives a secure email with a personal signing link. Invites are sent immediately.
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}