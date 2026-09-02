import { AppShell } from '@/components/layout/app-shell';

export default function SettingsPage() {
  return (
    <AppShell>
      <div>
        <h1 className="text-2xl font-semibold">Settings</h1>
        <p className="text-sm text-slate-500">Organization profile, workspace, team, and billing management.</p>
      </div>
    </AppShell>
  );
}