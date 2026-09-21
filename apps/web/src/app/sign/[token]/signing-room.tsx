'use client';

import { useCallback, useEffect, useState } from 'react';
import { FileText, PenLine, ShieldCheck } from 'lucide-react';
import { api, ApiError } from '@/lib/api';
import { Badge, Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button, Spinner } from '@/components/ui/button';
import type { RequestField } from '@/lib/types';

interface SigningSession {
  requestId: string;
  title: string;
  message: string | null;
  deadline: string | null;
  mode: 'SEQUENTIAL' | 'PARALLEL';
  allowsSigning: boolean;
  document: { id: string; fileName: string; downloadUrl: string };
  signer: {
    id: string;
    email: string;
    name: string | null;
    role: 'SIGNER' | 'APPROVER' | 'CC';
    status: string;
  };
  /**
   * The placed fields this signer must fill. Only this signer's — a placement
   * belongs to one signer by order, and the API never returns another's.
   */
  requestedFields: RequestField[];
}

const SIGNATURE_LIKE: RequestField['type'][] = ['SIGNATURE', 'INITIAL'];

function label(field: RequestField): string {
  return field.name ?? field.type.replaceAll('_', ' ').toLowerCase();
}

function isEmpty(value: unknown): boolean {
  return value === undefined || value === null || (typeof value === 'string' && value.trim() === '');
}

/** Options can arrive as a bare list or wrapped; both shapes are in the wild. */
function dropdownOptions(field: RequestField): string[] {
  const raw = field.options as unknown;
  if (Array.isArray(raw)) return raw.map((o) => String(o));
  if (raw && typeof raw === 'object') {
    const rec = raw as Record<string, unknown>;
    const list = rec.choices ?? rec.options ?? rec.values;
    if (Array.isArray(list)) return list.map((o) => String(o));
  }
  return [];
}

function FieldInput({
  field,
  value,
  onChange,
  disabled,
}: {
  field: RequestField;
  value: unknown;
  onChange: (value: unknown) => void;
  disabled: boolean;
}) {
  const id = `field-${field.id}`;
  const common = { id, disabled, className: 'input', 'aria-required': field.isRequired };

  if (field.type === 'CHECKBOX') {
    return (
      <label htmlFor={id} className="flex items-center gap-2 text-sm">
        <input
          id={id}
          type="checkbox"
          disabled={disabled}
          className="h-4 w-4 rounded border-slate-300 text-primary-600"
          checked={value === true}
          onChange={(e) => onChange(e.target.checked)}
        />
        {label(field)}
        {field.isRequired && <span className="text-red-500">*</span>}
      </label>
    );
  }

  if (field.type === 'DROPDOWN') {
    const options = dropdownOptions(field);
    return (
      <select
        {...common}
        value={typeof value === 'string' ? value : ''}
        onChange={(e) => onChange(e.target.value)}
      >
        <option value="">Select…</option>
        {options.map((option) => (
          <option key={option} value={option}>
            {option}
          </option>
        ))}
      </select>
    );
  }

  if (field.type === 'ADDRESS') {
    return (
      <textarea
        {...common}
        rows={3}
        value={typeof value === 'string' ? value : ''}
        onChange={(e) => onChange(e.target.value)}
      />
    );
  }

  if (field.type === 'ATTACHMENT') {
    // Uploading a file *into a request* is not a supported path yet; saying so is
    // better than a picker that appears to attach something and records nothing.
    return (
      <p className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-700">
        This template asks for an attachment, which this signing room cannot collect yet. Ask the
        sender to resend without it.
      </p>
    );
  }

  let type = 'text';
  if (field.type === 'DATE') type = 'date';
  else if (field.type === 'EMAIL') type = 'email';
  else if (field.type === 'PHONE') type = 'tel';

  return (
    <input
      {...common}
      type={type}
      value={typeof value === 'string' ? value : ''}
      placeholder={SIGNATURE_LIKE.includes(field.type) ? 'Type your full name' : undefined}
      onChange={(e) => onChange(e.target.value)}
    />
  );
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
  const [values, setValues] = useState<Record<string, unknown>>({});

  const load = useCallback(async () => {
    try {
      const data = await api.get<SigningSession>(
        `/api/v1/signatures/public/${encodeURIComponent(token)}`,
      );
      setSession(data);
      // A placement that already carries a value was filled in an earlier visit
      // that did not complete; the room opens on what they answered, not blank.
      const existing: Record<string, unknown> = {};
      for (const field of data.requestedFields ?? []) {
        if (!isEmpty(field.value)) existing[field.id] = field.value;
      }
      setValues(existing);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Unable to open signing session');
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => {
    void load();
  }, [load]);

  const fields = session?.requestedFields ?? [];
  const missing = fields.filter((f) => f.isRequired && isEmpty(values[f.id]));
  const canSign = fields.length === 0 || missing.length === 0;

  async function sign() {
    setAction('sign');
    setError(null);
    try {
      const payload = fields
        .filter((f) => !isEmpty(values[f.id]))
        .map((f) => ({ id: f.id, value: values[f.id] }));
      await api.post(`/api/v1/signatures/public/${encodeURIComponent(token)}/sign`, {
        type: 'TYPED',
        ...(payload.length ? { fields: payload } : {}),
      });
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

  if (error && !session) {
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
              Your response has been recorded. A signed copy and the audit trail are available from
              the sender.
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
                  This request is in sequential order — you can review, but signing unlocks once it
                  is your turn.
                </div>
              )}
              {session.message && (
                <blockquote className="rounded-lg border-l-4 border-primary-500 bg-slate-50 px-4 py-3 text-sm text-slate-600">
                  {session.message}
                </blockquote>
              )}
              {session.deadline && (
                <p className="text-xs text-slate-500">
                  Deadline: {new Date(session.deadline).toLocaleString()}
                </p>
              )}
              <div className="flex items-center justify-between rounded-lg border border-slate-200 px-4 py-3">
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium">{session.document.fileName}</p>
                  <p className="text-xs text-slate-500">PDF · securely stored by the sender</p>
                </div>
                <a
                  href={session.document.downloadUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="btn-outline"
                >
                  View
                </a>
              </div>

              {fields.length > 0 && (
                <div className="space-y-3 rounded-lg border border-slate-200 px-4 py-4">
                  <div className="flex items-center gap-2">
                    <PenLine className="h-4 w-4 text-primary-600" />
                    <p className="text-sm font-medium">Complete these fields</p>
                    <Badge tone={canSign ? 'green' : 'amber'}>
                      {fields.length - missing.length}/{fields.length}
                    </Badge>
                  </div>
                  {fields.map((field) => (
                    <div key={field.id} className="space-y-1">
                      {field.type !== 'CHECKBOX' && (
                        <label className="label" htmlFor={`field-${field.id}`}>
                          {label(field)}
                          {field.isRequired && <span className="ml-1 text-red-500">*</span>}
                          <span className="ml-1 text-xs font-normal text-slate-400">
                            page {field.pageNumber}
                          </span>
                        </label>
                      )}
                      <FieldInput
                        field={field}
                        value={values[field.id]}
                        disabled={!session.allowsSigning || action !== null}
                        onChange={(value) =>
                          setValues((prev) => ({ ...prev, [field.id]: value }))
                        }
                      />
                    </div>
                  ))}
                  {missing.length > 0 && (
                    <p className="text-xs text-amber-700">
                      Still required: {missing.map(label).join(', ')}
                    </p>
                  )}
                </div>
              )}

              {error && <p className="text-sm text-red-600">{error}</p>}

              <div className="flex items-center justify-between gap-3 pt-2">
                <Button
                  variant="danger"
                  onClick={decline}
                  loading={action === 'decline'}
                  disabled={action === 'sign'}
                >
                  Decline
                </Button>
                <Button
                  onClick={sign}
                  loading={action === 'sign'}
                  disabled={action === 'decline' || !session.allowsSigning || !canSign}
                >
                  Sign document
                </Button>
              </div>
            </>
          )}
          <div className="flex items-center gap-2 pt-2 text-xs text-slate-400">
            <ShieldCheck className="h-4 w-4" />
            Your IP address, timestamp, browser, and the values you complete are recorded to the
            audit trail. Powered by Signara.
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
