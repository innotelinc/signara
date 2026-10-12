'use client';

import { useEffect, useState } from 'react';
import { Info, Signature } from 'lucide-react';
import { api, ApiError } from '@/lib/api';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import type { DocumentDetail } from '@/lib/types';

/** `GET /templates` items, with the field count the picker reports. */
interface TemplateOption {
  id: string;
  name: string;
  status: string;
  _count?: { fields: number };
}

/**
 * A template as the picker lists it: name, how many fields it would collect, and
 * its status when that is not the ordinary ACTIVE one.
 */
export function templateOptionLabel(template: TemplateOption): string {
  const fields = template._count ? ` (${template._count.fields} fields)` : '';
  const status = template.status !== 'ACTIVE' ? ` — ${template.status.toLowerCase()}` : '';
  return `${template.name}${fields}${status}`;
}

/**
 * "Sign yourself" — the choice of template whose placed fields this request
 * collects.
 *
 * Choosing a template here is the difference between signing a document and
 * signing a blank page: the API copies the template's placements onto the
 * request and binds them to the caller's own signer row, so the room opens with
 * the fields the sender placed and their values reach the evidence. A document
 * already linked to a template preselects it; picking a different one relinks
 * the document, so a later send collects the same fields.
 */
export function SelfSignPanel({
  document,
  onClose,
}: {
  document: DocumentDetail;
  onClose: () => void;
}) {
  const [templates, setTemplates] = useState<TemplateOption[]>([]);
  const [templateId, setTemplateId] = useState(document.templateId ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .get<{ items: TemplateOption[] }>('/api/v1/templates?limit=100')
      .then((result) => setTemplates(result.items))
      .catch(() => {
        /* the list is a convenience: an already-linked document needs none of it */
      });
  }, []);

  const chosen = templates.find((template) => template.id === templateId);
  const placedFields = chosen?._count?.fields ?? (document.templateId === templateId ? null : 0);
  const relinking = Boolean(templateId) && templateId !== document.templateId;

  async function start() {
    setBusy(true);
    setError(null);
    try {
      const { url } = await api.post<{ url: string; fieldsPlaced: number }>(
        '/api/v1/signatures/self-sign',
        {
          documentId: document.id,
          ...(templateId ? { templateId } : {}),
        },
      );
      window.location.assign(url);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not start a signing session');
      setBusy(false);
    }
  }

  return (
    <Card className="mb-6 border-primary-100">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Signature className="h-4 w-4 text-primary-600" />
          Sign yourself
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-sm text-slate-600">
          This creates a request with you as its only signer and opens it here — nothing is emailed.
          The fields you fill in the room come from the template you choose.
        </p>

        <div>
          <label className="label" htmlFor="self-sign-template">
            Template whose fields you fill
          </label>
          <select
            id="self-sign-template"
            className="input"
            value={templateId}
            onChange={(e) => setTemplateId(e.target.value)}
          >
            <option value="">No template — sign the document as it is</option>
            {templates.map((template) => (
              <option key={template.id} value={template.id}>
                {templateOptionLabel(template)}
              </option>
            ))}
          </select>
        </div>

        {placedFields === 0 ? (
          <p className="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-xs text-amber-800">
            <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span>
              With no template, the request collects your signature and nothing else — anything the
              document needs filled has to be placed on a template first (Templates → New), then
              chosen here.
            </span>
          </p>
        ) : null}

        {placedFields !== null && placedFields > 0 ? (
          <p className="rounded-lg border border-slate-200 bg-slate-50 px-4 py-3 text-xs text-slate-600">
            {placedFields} placed field{placedFields === 1 ? '' : 's'} from{' '}
            {chosen?.name ?? 'this template'} will be collected while you sign, and recorded with
            your signature.
          </p>
        ) : null}

        {relinking ? (
          <p className="text-xs text-slate-500">
            This document will be linked to that template, so a later send collects the same fields.
          </p>
        ) : null}

        {error && (
          <p className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
            {error}
          </p>
        )}

        <div className="flex justify-end gap-3">
          <Button variant="outline" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={() => void start()} loading={busy}>
            <Signature className="h-4 w-4" />
            Open signing room
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
