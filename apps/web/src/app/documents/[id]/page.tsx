import type { Metadata } from 'next';
import { AppShell } from '@/components/layout/app-shell';
import { DocumentDetailClient } from './document-detail-client';

export const metadata: Metadata = { title: 'Document' };

export default function DocumentDetailPage({ params }: { params: { id: string } }) {
  return (
    <AppShell>
      <DocumentDetailClient documentId={params.id} />
    </AppShell>
  );
}