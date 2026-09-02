'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { api, ApiError } from '@/lib/api';
import { Badge, Card, CardContent } from '@/components/ui/card';
import { Spinner } from '@/components/ui/button';
import { FileSignature, Plus, Settings2 } from 'lucide-react';

interface TemplateItem {
  id: string;
  name: string;
  description: string | null;
  status: 'DRAFT' | 'ACTIVE' | 'ARCHIVED';
  _count: { fields: number; documents: number };
  updatedAt: string;
}

export function Templates() {
  const [items, setItems] = useState<TemplateItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const result = await api.get<{ total: number; items: TemplateItem[] }>('/api/v1/templates?limit=50');
        setItems(result.items);
      } catch (err) {
        setError(err instanceof ApiError ? err.message : 'Failed to load templates');
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  return (
    <div>
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Templates</h1>
          <p className="text-sm text-slate-500">Reusable signing workflows with dynamic fields and variables.</p>
        </div>
        <Link href="/templates/new" className="btn-primary">
          <Plus className="h-4 w-4" />
          New template
        </Link>
      </div>

      {error && (
        <div className="mb-6 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div>
      )}

      {loading ? (
        <div className="flex justify-center py-12">
          <Spinner className="h-6 w-6 text-primary-500" />
        </div>
      ) : items.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center py-12 text-center">
            <FileSignature className="mb-3 h-8 w-8 text-slate-300" />
            <p className="mb-4 text-sm text-slate-500">No templates yet. Create one to reuse fields across documents.</p>
            <Link href="/templates/new" className="btn-primary">
              <Plus className="h-4 w-4" />
              Create your first template
            </Link>
          </CardContent>
        </Card>
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {items.map((template) => (
            <Card key={template.id}>
              <CardContent>
                <div className="mb-2 flex items-center justify-between">
                  <h3 className="font-semibold">{template.name}</h3>
                  <Badge tone={template.status === 'ACTIVE' ? 'green' : template.status === 'ARCHIVED' ? 'gray' : 'amber'}>
                    {template.status}
                  </Badge>
                </div>
                {template.description && <p className="mb-3 text-sm text-slate-500">{template.description}</p>}
                <p className="mb-4 text-xs text-slate-400">
                  {template._count.fields} fields · {template._count.documents} documents · updated{' '}
                  {new Date(template.updatedAt).toLocaleDateString()}
                </p>
                <div className="border-t border-slate-100 pt-3">
                  <Link href={`/templates/${template.id}/edit`} className="btn-outline h-8 w-full px-2.5 text-xs">
                    <Settings2 className="h-3.5 w-3.5" />
                    Edit fields
                  </Link>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}