'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { ArrowLeft, FileSignature } from 'lucide-react';
import { api, ApiError } from '@/lib/api';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import type { TemplateDetail } from '@/lib/types';

export function NewTemplateClient() {
  const router = useRouter();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  async function create(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) {
      setError('A template name is required');
      return;
    }
    setCreating(true);
    setError(null);
    try {
      const template = await api.post<TemplateDetail>('/api/v1/templates', {
        name: name.trim(),
        description: description.trim() || undefined,
        fields: [],
      });
      router.push(`/templates/${template.id}/edit`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not create template');
      setCreating(false);
    }
  }

  return (
    <div className="mx-auto max-w-xl">
      <Link
        href="/templates"
        className="mb-4 inline-flex items-center gap-1 text-sm text-slate-500 hover:text-slate-700"
      >
        <ArrowLeft className="h-4 w-4" />
        Back to templates
      </Link>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <FileSignature className="h-4 w-4" />
            New template
          </CardTitle>
          <CardDescription>
            Create a reusable signing workflow — you&apos;ll place fields on the next screen.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={(e) => void create(e)} className="space-y-5">
            {error && (
              <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
                {error}
              </div>
            )}
            <div>
              <label className="label" htmlFor="template-name">
                Template name
              </label>
              <input
                id="template-name"
                className="input"
                placeholder="e.g. Employment offer letter"
                value={name}
                onChange={(e) => setName(e.target.value)}
                autoFocus
              />
            </div>
            <div>
              <label className="label" htmlFor="template-desc">
                Description (optional)
              </label>
              <textarea
                id="template-desc"
                className="input"
                rows={3}
                placeholder="What is this template used for?"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
              />
            </div>
            <div className="flex justify-end gap-3">
              <Link href="/templates" className="btn-outline">
                Cancel
              </Link>
              <Button type="submit" loading={creating}>
                Create template
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
