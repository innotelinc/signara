import { renderToString } from 'react-dom/server';
import { SelfSignPanel, templateOptionLabel } from './self-sign-panel';
import type { DocumentDetail } from '@/lib/types';

/**
 * "Sign yourself" has to say where the fields you will fill come from, and say
 * it plainly when the answer is "nowhere". These tests pin the picker's copy and
 * the warning, which is the part a browser cannot be trusted to have shown; the
 * API spec pins what choosing a template actually does to the request.
 */
function document(over: Partial<DocumentDetail> = {}): DocumentDetail {
  return {
    id: 'doc-1',
    title: 'Contract',
    description: null,
    fileName: 'Contract.pdf',
    fileKey: 'documents/doc-1.pdf',
    contentType: 'application/pdf',
    sizeBytes: '1024',
    checksumSha256: 'a'.repeat(64),
    status: 'DRAFT',
    tags: [],
    version: 1,
    updatedAt: '2026-10-12T09:00:00.000Z',
    createdAt: '2026-10-12T08:00:00.000Z',
    templateId: null,
    versions: [],
    signingRequests: [],
    ...over,
  };
}

/** React separates adjacent text nodes with `<!-- -->` comments in SSR output. */
function text(html: string): string {
  return html.replace(/<!-- -->/g, '');
}

describe('templateOptionLabel', () => {
  it('names the template and how many fields it would collect', () => {
    expect(
      templateOptionLabel({
        id: 'tpl-1',
        name: 'Master Service Agreement',
        status: 'ACTIVE',
        _count: { fields: 7 },
      }),
    ).toBe('Master Service Agreement (7 fields)');
  });

  it('marks a template that is not active, and one with no field count', () => {
    expect(templateOptionLabel({ id: 't2', name: 'Draft NDA', status: 'DRAFT' })).toBe(
      'Draft NDA — draft',
    );
    expect(
      templateOptionLabel({
        id: 't3',
        name: 'Archived',
        status: 'ARCHIVED',
        _count: { fields: 0 },
      }),
    ).toBe('Archived (0 fields) — archived');
  });
});

describe('SelfSignPanel', () => {
  it('offers signing the document as it is, and warns when nothing would be collected', () => {
    const html = text(renderToString(<SelfSignPanel document={document()} onClose={() => {}} />));
    expect(html).toContain('Sign yourself');
    expect(html).toContain('No template — sign the document as it is');
    expect(html).toContain('Open signing room');
    // The warning is the point: no template means the request collects only the
    // signature, and the caller should know that before opening the room.
    expect(html).toContain('collects your signature and nothing else');
    expect(html).toContain('Templates → New');
  });

  it('does not warn about a document that already carries a template link', () => {
    const html = text(
      renderToString(
        <SelfSignPanel document={document({ templateId: 'tpl-9' })} onClose={() => {}} />,
      ),
    );
    expect(html).not.toContain('collects your signature and nothing else');
    // The room's copy still explains where the fields come from.
    expect(html).toContain('fields you fill in the room come from the template you choose');
  });
});
