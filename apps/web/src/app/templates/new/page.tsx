import type { Metadata } from 'next';
import { AppShell } from '@/components/layout/app-shell';
import { NewTemplateClient } from './new-template-client';

export const metadata: Metadata = { title: 'New template' };

export default function NewTemplatePage() {
  return (
    <AppShell>
      <NewTemplateClient />
    </AppShell>
  );
}