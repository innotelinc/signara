'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { api, ApiError } from '@/lib/api';
import { env } from '@/lib/env';
import { Badge, Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button, Spinner } from '@/components/ui/button';
import { Send, UploadCloud } from 'lucide-react';

interface DocumentItem {
  id: string;
  title: string;
  fileName: string;
  status: string;
  updatedAt: string;
  contentType: string | null;
}

interface TemplateOption {
  id: string;
  name: string;
  status: string;
}

export function Documents() {
  const [items, setItems] = useState<DocumentItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [templates, setTemplates] = useState<TemplateOption[]>([]);
  // A document's template is where its placed fields come from at send time (#81),
  // so it is chosen here rather than left unset — an unlinked document sends a
  // blank page to sign.
  const [templateId, setTemplateId] = useState('');
  const fileInput = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    try {
      setError(null);
      const result = await api.get<{ total: number; items: DocumentItem[] }>('/api/v1/documents?limit=50');
      setItems(result.items);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to load documents');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    api
      .get<{ items: TemplateOption[] }>('/api/v1/templates?limit=100')
      .then((result) => setTemplates(result.items))
      .catch(() => {
        /* templates are optional; uploading without one stays possible */
      });
  }, []);

  async function onFileSelected(file: File | undefined) {
    if (!file) return;
    setUploading(true);
    setError(null);
    const form = new FormData();
    form.append('file', file);
    form.append('title', file.name.replace(/\.[^.]+$/, ''));
    if (templateId) form.append('templateId', templateId);

    try {
      // Direct multipart upload to the API (large files stream through MinIO)
      const token = document.querySelector<HTMLMetaElement>('meta[name="access-token"]')?.content;
      const response = await fetch(`${env.apiUrl}/api/v1/documents/upload`, {
        method: 'POST',
        headers: token ? { Authorization: `Bearer ${token}` } : undefined,
        body: form,
        credentials: 'include',
      });
      if (!response.ok) throw new ApiError(response.status, 'Upload failed');
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Upload failed');
    } finally {
      setUploading(false);
      if (fileInput.current) fileInput.current.value = '';
    }
  }

  return (
    <div>
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Documents</h1>
          <p className="text-sm text-slate-500">Upload, store, and manage your agreements.</p>
        </div>
        <div className="flex items-center gap-2">
          <label className="sr-only" htmlFor="upload-template">
            Template
          </label>
          <select
            id="upload-template"
            className="input h-10 w-56"
            value={templateId}
            onChange={(e) => setTemplateId(e.target.value)}
            title="Placed fields for this document come from the template you pick here"
          >
            <option value="">No template</option>
            {templates.map((template) => (
              <option key={template.id} value={template.id}>
                {template.name}
                {template.status !== 'ACTIVE' ? ` (${template.status.toLowerCase()})` : ''}
              </option>
            ))}
          </select>
          <input
            ref={fileInput}
            type="file"
            accept=".pdf,.docx,.png,.jpg,.jpeg,.webp"
            className="hidden"
            onChange={(e) => onFileSelected(e.target.files?.[0])}
          />
          <Button onClick={() => fileInput.current?.click()} loading={uploading}>
            <UploadCloud className="h-4 w-4" />
            Upload
          </Button>
        </div>
      </div>

      {error && (
        <div className="mb-6 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div>
      )}

      <Card>
        <CardHeader>
          <CardTitle>All documents</CardTitle>
        </CardHeader>
        <CardContent className="px-0">
          {loading ? (
            <div className="flex justify-center py-12">
              <Spinner className="h-6 w-6 text-primary-500" />
            </div>
          ) : items.length === 0 ? (
            <p className="px-5 py-8 text-center text-sm text-slate-500">
              No documents yet — upload a PDF, DOCX, or image to get started.
            </p>
          ) : (
            <table className="w-full">
              <thead className="border-b border-slate-200">
                <tr>
                  <th className="th">Title</th>
                  <th className="th">File</th>
                  <th className="th">Status</th>
                  <th className="th">Uploaded</th>
                  <th className="th">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {items.map((doc) => (
                  <tr key={doc.id} className="group hover:bg-slate-50">
                    <td className="td">
                      <Link href={`/documents/${doc.id}`} className="font-medium text-ink-900 group-hover:text-primary-700">
                        {doc.title}
                      </Link>
                    </td>
                    <td className="td text-slate-500">{doc.fileName}</td>
                    <td className="td">
                      <Badge>{doc.status.replaceAll('_', ' ')}</Badge>
                    </td>
                    <td className="td text-slate-500">{new Date(doc.updatedAt).toLocaleDateString()}</td>
                    <td className="td">
                      <Link href={`/documents/${doc.id}/send`} className="btn-outline h-8 px-2.5 text-xs">
                        <Send className="h-3.5 w-3.5" />
                        Send
                      </Link>
                    </td>
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