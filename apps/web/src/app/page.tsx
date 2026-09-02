import Link from 'next/link';
import { PenLine } from 'lucide-react';
import { env } from '@/lib/env';

export default function LandingPage() {
  return (
    <div className="flex min-h-screen flex-col bg-white">
      <header className="flex items-center justify-between px-6 py-4">
        <div className="flex items-center gap-2">
          <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-primary-500">
            <PenLine className="h-5 w-5 text-white" />
          </span>
          <span className="text-lg font-semibold">Signara</span>
        </div>
        <Link
          href={`${env.apiUrl}/api/v1/auth/login?next=/dashboard`}
          className="btn-primary"
        >
          Sign in
        </Link>
      </header>

      <main className="flex flex-1 flex-col items-center justify-center px-6 text-center">
        <h1 className="max-w-3xl text-4xl font-bold tracking-tight text-ink-900 sm:text-5xl">
          Secure Every Signature.
        </h1>
        <p className="mt-4 max-w-2xl text-lg text-slate-600">
          The open-source digital document signing and agreement management platform.
          Self-hosted, multi-tenant, Authentik-native, and audit-ready out of the box.
        </p>
        <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
          <Link href={`${env.apiUrl}/api/v1/auth/login?next=/dashboard`} className="btn-primary px-6 py-3">
            Get started
          </Link>
          <a href="/sign/demo" className="btn-outline px-6 py-3">
            Try a demo signing room
          </a>
        </div>
        <ul className="mt-16 flex flex-wrap items-center justify-center gap-x-8 gap-y-3 text-sm text-slate-500">
          <li>Electronic signatures</li>
          <li>Audit trails</li>
          <li>Template automation</li>
          <li>Workflow approvals</li>
          <li>Multi-tenant</li>
        </ul>
      </main>

      <footer className="px-6 py-4 text-center text-xs text-slate-400">
        Signara · signara.innotel.us · AGPL-3.0
      </footer>
    </div>
  );
}