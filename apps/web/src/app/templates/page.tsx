import type { Metadata } from 'next';
import { AppShell } from '@/components/layout/app-shell';
import { Templates } from './templates-client';

export const metadata: Metadata = { title: 'Templates' };

export default function TemplatesPage() {
  return (
    <AppShell>
      <Templates />
    </AppShell>
  );
}