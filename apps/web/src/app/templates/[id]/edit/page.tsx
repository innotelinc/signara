import type { Metadata } from 'next';
import { AppShell } from '@/components/layout/app-shell';
import { TemplateEditorClient } from './template-editor-client';

export const metadata: Metadata = { title: 'Template editor' };

export default function TemplateEditorPage({ params }: { params: { id: string } }) {
  return (
    <AppShell>
      <TemplateEditorClient templateId={params.id} />
    </AppShell>
  );
}