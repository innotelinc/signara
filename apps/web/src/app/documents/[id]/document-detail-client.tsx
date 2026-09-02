'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  ArrowLeft,
  Clock,
  Download,
  FileText,
  FileUp,
  PenLine,
  Send,
  ShieldCheck,
  Trash2,
} from 'lucide-react';
import { api, ApiError } from '@/lib/api';
import { env } from '@/lib/env';
import { Badge, Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button, Spinner } from '@/components/ui/button';
import type { DocumentDetail } from '@/lib/types';

const STATUS_TONE: Record<string, 'gray' | 'green' | 'blue' | 'amber' | 'red'> = {
  DRAFT: 'gray',
  AWAITING_SIGNATURE: 'blue',
  IN_PROGRESS: 'amber',
  COMPLETED: 'green',
  VOIDED: 'red',
  CANCELLED: 'red',
  EXPIRED: 'red',
};

function formatBytes(bytes: string): string {
  const n = Number(bytes);
  if (!Number.isFinite(n) || n === 0) return '—';
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = n;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value >= 10 || unit === 0 ? 0 : 1)} ${units[unit]}`;
}

export function DocumentDetailClient({ documentId }: { documentId: string }) {
  const router = useRouter();
  const [doc, setDoc] = useState<DocumentDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const versionInput = useRef<HTMLInputElement>(null);
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');

  const load = useCallback(async () => {
    try {
      setError(null);
      const result = await api.get<DocumentDetail>(`/api/v1/documents/${documentId}`);
      setDoc(result);
      setTitle(result.title);
      setDescription(result.description ?? '');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to load document');
    } finally {
      setLoading(false);
    }
  }, [documentId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function download(id: string, version?: number) {
    if (!doc) return;
    setBusy(`dl-${version ?? 'current'}`);
    try {
      const { url } = await api.get<{ url: string }>(
        `/api/v1/documents/${id}/download${version ? `?version=${version}` : ''}`,
      );
      window.open(url, '_blank', 'noopener,noreferrer');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Download failed');
    } finally {
      setBusy(null);
    }
  }

  async function onNewVersion(file: File | undefined) {
    if (!file || !doc) return;
    setBusy('version');
    setError(null);
    const form = new FormData();
    form.append('file', file);
    try {
      const token = document.querySelector<HTMLMetaElement>('meta[name="access-token"]')?.content;
      const response = await fetch(`${env.apiUrl}/api/v1/documents/${doc.id}/versions`, {
        method: 'POST',
        headers: token ? { Authorization: `Bearer ${token}` } : undefined,
        body: form,
        credentials: 'include',
      });
      if (!response.ok) throw new ApiError(response.status, 'Version upload failed');
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Version upload failed');
    } finally {
      setBusy(null);
      if (versionInput.current) versionInput.current.value = '';
    }
  }

  async function saveMetadata() {
    if (!doc) return;
    setBusy('meta');
    setError(null);
    try {
      await api.patch(`/api/v1/documents/${doc.id}`, { title, description });
      setEditing(false);
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not save changes');
    } finally {
      setBusy(null);
    }
  }

  async function remove() {
    if (!doc) return;
    if (!window.confirm('Delete this document? This can be undone from audit history.')) return;
    setBusy('delete');
    try {
      await api.del(`/api/v1/documents/${doc.id}`);
      router.push('/documents');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not delete document');
      setBusy(null);
    }
  }

  if (loading) {
    return (
      <div className="flex h-64 items-center justify-center">
        <Spinner className="h-8 w-8 text-primary-500" />
      </div>
    );
  }

  if (!doc) {
    return (
      <div>
        <p className="text-sm text-slate-500">{error ?? 'Document not found.'}</p>
        <Link href="/documents" className="btn-outline mt-4">
          <ArrowLeft className="h-4 w-4" />
          Back to documents
        </Link>
      </div>
    );
  }

  return (
    <div>
      <div className="mb-6 flex items-start justify-between gap-4">
        <div>
          <Link href="/documents" className="mb-2 inline-flex items-center gap-1 text-sm text-slate-500 hover:text-slate-700">
            <ArrowLeft className="h-4 w-4" />
            Documents
          </Link>
          {editing ? (
            <div className="max-w-md">
              <input className="input mb-2" value={title} onChange={(e) => setTitle(e.target.value)} aria-label="Title" />
              <textarea
                className="input"
                rows={2}
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                aria-label="Description"
              />
            </div>
          ) : (
            <>
              <h1 className="text-2xl font-semibold">{doc.title}</h1>
              <p className="mt-1 text-sm text-slate-500">{doc.description || doc.fileName}</p>
            </>
          )}
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <Badge tone={STATUS_TONE[doc.status] ?? 'gray'}>{doc.status.replaceAll('_', ' ')}</Badge>
            <Badge tone="blue">{doc.contentType ?? 'unknown type'}</Badge>
            {doc.tags.map((tag) => (
              <Badge key={tag} tone="teal">
                {tag}
              </Badge>
            ))}
          </div>
        </div>

        <div className="flex flex-wrap justify-end gap-2">
          {editing ? (
            <>
              <Button variant="outline" onClick={() => setEditing(false)}>
                Cancel
              </Button>
              <Button onClick={() => void saveMetadata()} loading={busy === 'meta'}>
                Save changes
              </Button>
            </>
          ) : (
            <>
              <Button variant="outline" onClick={() => void download(doc.id)} loading={busy === 'dl-current'}>
                <Download className="h-4 w-4" />
                Download
              </Button>
              <Button variant="outline" onClick={() => setEditing(true)}>
                <PenLine className="h-4 w-4" />
                Edit
              </Button>
              <input
                ref={versionInput}
                type="file"
                accept=".pdf,.docx,.png,.jpg,.jpeg,.webp"
                className="hidden"
                onChange={(e) => onNewVersion(e.target.files?.[0])}
              />
              <Button variant="outline" onClick={() => versionInput.current?.click()} loading={busy === 'version'}>
                <FileUp className="h-4 w-4" />
                New version
              </Button>
              <Link href={`/documents/${doc.id}/send`} className="btn-primary">
                <Send className="h-4 w-4" />
                Send for signature
              </Link>
            </>
          )}
        </div>
      </div>

      {error && (
        <div className="mb-6 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div>
      )}

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        {/* Left column — file + activity */}
        <div className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle>File</CardTitle>
            </CardHeader>
            <CardContent>
              <dl className="space-y-3 text-sm">
                <div className="flex justify-between gap-4">
                  <dt className="text-slate-500">File name</dt>
                  <dd className="truncate font-medium">{doc.fileName}</dd>
                </div>
                <div className="flex justify-between gap-4">
                  <dt className="text-slate-500">Size</dt>
                  <dd className="font-medium">{formatBytes(doc.sizeBytes)}</dd>
                </div>
                <div className="flex justify-between gap-4">
                  <dt className="text-slate-500">SHA-256</dt>
                  <dd className="font-mono text-xs">{doc.checksumSha256.slice(0, 16)}…</dd>
                </div>
                <div className="flex justify-between gap-4">
                  <dt className="text-slate-500">Uploaded</dt>
                  <dd className="font-medium">{new Date(doc.createdAt).toLocaleString()}</dd>
                </div>
                <div className="flex justify-between gap-4">
                  <dt className="text-slate-500">Updated</dt>
                  <dd className="font-medium">{new Date(doc.updatedAt).toLocaleString()}</dd>
                </div>
              </dl>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Signing requests</CardTitle>
              <CardDescription>{doc.signingRequests.length} total</CardDescription>
            </CardHeader>
            <CardContent className="px-0">
              {doc.signingRequests.length === 0 ? (
                <p className="px-5 py-6 text-center text-sm text-slate-500">
                  No signing requests yet. Send this document for signature to start one.
                </p>
              ) : (
                <ul className="divide-y divide-slate-100">
                  {doc.signingRequests.map((req) => (
                    <li key={req.id} className="flex items-center justify-between px-5 py-3">
                      <div className="flex items-center gap-3">
                        <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary-50">
                          <FileText className="h-4 w-4 text-primary-600" />
                        </span>
                        <div>
                          <p className="text-sm font-medium">{req.title ?? doc.title}</p>
                          <p className="text-xs text-slate-500">
                            {req.mode.toLowerCase()} · {new Date(req.createdAt).toLocaleDateString()}
                          </p>
                        </div>
                      </div>
                      <Badge tone={STATUS_TONE[req.status] ?? 'gray'}>{req.status.replaceAll('_', ' ')}</Badge>
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>
        </div>

        {/* Right column — version history */}
        <div className="lg:col-span-2">
          <Card>
            <CardHeader>
              <CardTitle>Version history</CardTitle>
              <CardDescription>{doc.versions.length} version(s) · immutable</CardDescription>
            </CardHeader>
            <CardContent className="px-0">
              <table className="w-full">
                <thead className="border-b border-slate-200">
                  <tr>
                    <th className="th">Version</th>
                    <th className="th">Change note</th>
                    <th className="th">Size</th>
                    <th className="th">Uploaded</th>
                    <th className="th">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {doc.versions.map((version) => (
                    <tr key={version.id} className="hover:bg-slate-50">
                      <td className="td font-medium">v{version.version}</td>
                      <td className="td text-slate-500">{version.changeNote ?? '—'}</td>
                      <td className="td text-slate-500">{formatBytes(version.sizeBytes)}</td>
                      <td className="td text-slate-500">
                        <span className="inline-flex items-center gap-1">
                          <Clock className="h-3 w-3" />
                          {new Date(version.createdAt).toLocaleString()}
                        </span>
                      </td>
                      <td className="td">
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => void download(doc.id, version.version)}
                          loading={busy === `dl-${version.version}`}
                        >
                          <Download className="h-4 w-4" />
                          Download
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </CardContent>
          </Card>
        </div>
      </div>

      <div className="mt-6 flex justify-end">
        <Button variant="danger" onClick={() => void remove()} loading={busy === 'delete'}>
          <Trash2 className="h-4 w-4" />
          Delete document
        </Button>
      </div>

      <div className="mt-4 flex items-center gap-2 text-xs text-slate-400">
        <ShieldCheck className="h-3.5 w-3.5" />
        Downloads are time-limited presigned URLs; every version is checksum-verified.
      </div>
    </div>
  );
}