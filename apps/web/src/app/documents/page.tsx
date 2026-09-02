import type { Metadata } from 'next';
import { AppShell } from '@/components/layout/app-shell';
import { Documents } from './documents-client';

export const metadata: Metadata = { title: 'Documents' };

export default function DocumentsPage() {
  return (
    <AppShell>
      <Documents />
    </AppShell>
  );
}