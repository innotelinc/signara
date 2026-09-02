import type { Metadata } from 'next';
import { AppShell } from '@/components/layout/app-shell';
import { SendWizardClient } from './send-wizard-client';

export const metadata: Metadata = { title: 'Send for signature' };

export default function SendWizardPage({ params }: { params: { id: string } }) {
  return (
    <AppShell>
      <SendWizardClient documentId={params.id} />
    </AppShell>
  );
}