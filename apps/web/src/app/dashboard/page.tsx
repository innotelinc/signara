import type { Metadata } from 'next';
import { AppShell } from '@/components/layout/app-shell';
import { Dashboard } from './dashboard-client';

export const metadata: Metadata = { title: 'Dashboard' };

export default function DashboardPage() {
  return (
    <AppShell>
      <Dashboard />
    </AppShell>
  );
}