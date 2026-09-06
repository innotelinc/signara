import Link from 'next/link';
import {
  PenLine,
  ShieldCheck,
  FileSignature,
  Workflow,
  Layers,
  Fingerprint,
  CheckCircle2,
  ArrowRight,
  Lock,
  Globe2,
  FileCheck2,
  Timer,
  ScanLine,
} from 'lucide-react';
import { env } from '@/lib/env';

const FEATURES = [
  {
    icon: FileSignature,
    title: 'Electronic signatures',
    description:
      'Sign PDFs, DOCX and images with legally sound e-signatures backed by a full audit trail.',
  },
  {
    icon: ScanLine,
    title: 'Audit-grade trails',
    description:
      'Every view, edit and signature is recorded immutably — exportable evidence for any dispute.',
  },
  {
    icon: Workflow,
    title: 'Workflow approvals',
    description:
      'Route documents through ordered approvers and signers with reminders and decline handling.',
  },
  {
    icon: Layers,
    title: 'Template automation',
    description:
      'Turn recurring agreements into templates with dynamic fields and variables. Fill, send, done.',
  },
  {
    icon: Fingerprint,
    title: 'Authentik-native SSO',
    description:
      'Single sign-on through the Cerulean auth & trust stack — one identity across your platform.',
  },
  {
    icon: ShieldCheck,
    title: 'Self-hosted & private',
    description:
      'Your documents never leave your infrastructure. MinIO storage, Postgres records, zero data resale.',
  },
];

const STEPS = [
  {
    step: '01',
    title: 'Upload',
    description: 'Drop in a PDF, DOCX or image. Signara renders it instantly for signing.',
  },
  {
    step: '02',
    title: 'Add fields & route',
    description: 'Place signature, date and text fields. Send to signers in any order you choose.',
  },
  {
    step: '03',
    title: 'Sign & store',
    description: 'Signers approve from any device. Every action lands in the immutable audit trail.',
  },
];

export default function LandingPage() {
  const loginHref = `${env.apiUrl}/api/v1/auth/login?next=/dashboard`;

  return (
    <div className="flex min-h-screen flex-col bg-white text-ink-900">
      {/* Top bar */}
      <header className="border-b border-slate-100 bg-white">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-4">
          <div className="flex items-center gap-2.5">
            <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-primary-500 shadow-sm">
              <PenLine className="h-5 w-5 text-white" />
            </span>
            <span className="text-lg font-bold tracking-tight">Signara</span>
          </div>
          <div className="flex items-center gap-4">
            <Link href="/sign/demo" className="hidden text-sm font-medium text-slate-600 hover:text-ink-900 sm:block">
              Try the demo
            </Link>
            <Link href={loginHref} className="btn-primary">
              Sign in
            </Link>
          </div>
        </div>
      </header>

      {/* Hero */}
      <section className="bg-ink-950 text-white">
        <div className="mx-auto grid max-w-6xl gap-12 px-6 py-20 lg:grid-cols-2 lg:py-28">
          <div>
            <span className="inline-flex items-center gap-2 rounded-full border border-white/15 bg-white/5 px-3 py-1 text-xs font-medium text-slate-300">
              <span className="h-1.5 w-1.5 rounded-full bg-accent-400" />
              Open-source · Self-hosted · Authentik-native
            </span>
            <h1 className="mt-6 text-4xl font-bold tracking-tight sm:text-5xl">
              Secure every signature.
            </h1>
            <p className="mt-5 max-w-xl text-lg leading-relaxed text-slate-300">
              The document signing and agreement platform for teams that need control.
              Self-hosted, multi-tenant, audit-ready — and wired into your identity stack
              through Cerulean.
            </p>
            <div className="mt-8 flex flex-wrap items-center gap-3">
              <Link
                href={loginHref}
                className="btn bg-primary-500 px-6 py-3 text-base text-white hover:bg-primary-600"
              >
                Get started
                <ArrowRight className="h-4 w-4" />
              </Link>
              <a
                href="/sign/demo"
                className="btn border border-white/20 bg-white/5 px-6 py-3 text-base text-white hover:bg-white/10"
              >
                Try a demo signing room
              </a>
            </div>
            <ul className="mt-12 grid max-w-lg grid-cols-2 gap-x-6 gap-y-3 text-sm text-slate-400">
              {['Electronic signatures', 'Immutable audit trails', 'Template automation', 'Workflow approvals'].map(
                (item) => (
                  <li key={item} className="flex items-center gap-2">
                    <CheckCircle2 className="h-4 w-4 text-accent-400" />
                    {item}
                  </li>
                ),
              )}
            </ul>
          </div>

          {/* Hero visual */}
          <div className="flex items-center justify-center">
            <div className="w-full max-w-md rounded-2xl border border-white/10 bg-white/5 p-6 shadow-2xl">
              <div className="flex items-center justify-between border-b border-white/10 pb-4">
                <div className="flex items-center gap-2">
                  <FileCheck2 className="h-5 w-5 text-accent-400" />
                  <span className="text-sm font-semibold">Master Service Agreement.pdf</span>
                </div>
                <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-500/15 px-2.5 py-1 text-xs font-medium text-emerald-300">
                  <Lock className="h-3 w-3" />
                  Awaiting signature
                </span>
              </div>

              <div className="space-y-3 py-5">
                <div className="flex items-center gap-3 rounded-lg border border-white/10 bg-ink-900 px-4 py-3">
                  <span className="flex h-9 w-9 items-center justify-center rounded-full bg-primary-500 text-xs font-bold">
                    DH
                  </span>
                  <div className="flex-1">
                    <p className="text-sm font-medium">D. Hunter</p>
                    <p className="text-xs text-slate-400">Signer · role: Signatory</p>
                  </div>
                  <CheckCircle2 className="h-5 w-5 text-emerald-400" />
                </div>
                <div className="flex items-center gap-3 rounded-lg border border-white/10 bg-ink-900 px-4 py-3 opacity-70">
                  <span className="flex h-9 w-9 items-center justify-center rounded-full bg-slate-600 text-xs font-bold">
                    AL
                  </span>
                  <div className="flex-1">
                    <p className="text-sm font-medium">A. Lopez</p>
                    <p className="text-xs text-slate-400">Signer · role: Approver</p>
                  </div>
                  <Timer className="h-5 w-5 text-slate-400" />
                </div>
                <div className="flex items-center gap-3 rounded-lg border border-white/10 bg-ink-900 px-4 py-3 opacity-50">
                  <span className="flex h-9 w-9 items-center justify-center rounded-full bg-slate-700 text-xs font-bold">
                    +2
                  </span>
                  <div className="flex-1">
                    <p className="text-sm font-medium">2 more recipients</p>
                    <p className="text-xs text-slate-400">Ordered workflow</p>
                  </div>
                </div>
              </div>

              <div className="rounded-lg border border-dashed border-white/15 px-4 py-3 text-center text-xs text-slate-400">
                Every action recorded in the immutable audit trail
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* Trust bar */}
      <section className="border-b border-slate-100 bg-slate-50">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-center gap-x-10 gap-y-3 px-6 py-5 text-sm font-medium text-slate-500">
          <span className="flex items-center gap-2">
            <ShieldCheck className="h-4 w-4 text-primary-600" />
            SOC-2-style controls
          </span>
          <span className="flex items-center gap-2">
            <Fingerprint className="h-4 w-4 text-primary-600" />
            SSO via Cerulean Authentik
          </span>
          <span className="flex items-center gap-2">
            <Globe2 className="h-4 w-4 text-primary-600" />
            Multi-tenant workspaces
          </span>
          <span className="flex items-center gap-2">
            <Lock className="h-4 w-4 text-primary-600" />
            Encrypted at rest
          </span>
        </div>
      </section>

      {/* Features */}
      <section className="mx-auto max-w-6xl px-6 py-20">
        <div className="mx-auto max-w-2xl text-center">
          <h2 className="text-3xl font-bold tracking-tight">Everything your agreements need</h2>
          <p className="mt-3 text-lg text-slate-600">
            A complete signing workflow — from upload to archived, audit-ready document.
          </p>
        </div>
        <div className="mt-12 grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3">
          {FEATURES.map(({ icon: Icon, title, description }) => (
            <div
              key={title}
              className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm transition-shadow hover:shadow-md"
            >
              <span className="flex h-11 w-11 items-center justify-center rounded-lg bg-primary-50">
                <Icon className="h-5 w-5 text-primary-600" />
              </span>
              <h3 className="mt-4 text-base font-semibold">{title}</h3>
              <p className="mt-2 text-sm leading-relaxed text-slate-600">{description}</p>
            </div>
          ))}
        </div>
      </section>

      {/* How it works */}
      <section className="bg-slate-50">
        <div className="mx-auto max-w-6xl px-6 py-20">
          <div className="mx-auto max-w-2xl text-center">
            <h2 className="text-3xl font-bold tracking-tight">From upload to signed in minutes</h2>
            <p className="mt-3 text-lg text-slate-600">Three steps. No training required.</p>
          </div>
          <div className="mt-12 grid grid-cols-1 gap-5 md:grid-cols-3">
            {STEPS.map(({ step, title, description }) => (
              <div key={step} className="relative rounded-xl border border-slate-200 bg-white p-6">
                <span className="text-3xl font-bold text-primary-100">{step}</span>
                <h3 className="mt-2 text-lg font-semibold">{title}</h3>
                <p className="mt-2 text-sm leading-relaxed text-slate-600">{description}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* CTA */}
      <section className="bg-ink-950">
        <div className="mx-auto flex max-w-6xl flex-col items-center px-6 py-20 text-center">
          <span className="flex h-12 w-12 items-center justify-center rounded-xl bg-primary-500">
            <PenLine className="h-6 w-6 text-white" />
          </span>
          <h2 className="mt-6 max-w-2xl text-3xl font-bold tracking-tight text-white sm:text-4xl">
            Put your signatures on your own infrastructure.
          </h2>
          <p className="mt-4 max-w-xl text-lg text-slate-300">
            Sign in with your Cerulean identity and start signing in under a minute.
          </p>
          <Link
            href={loginHref}
            className="btn mt-8 bg-primary-500 px-8 py-3 text-base text-white hover:bg-primary-600"
          >
            Sign in with Cerulean
            <ArrowRight className="h-4 w-4" />
          </Link>
        </div>
      </section>

      {/* Footer */}
      <footer className="border-t border-slate-100 bg-white">
        <div className="mx-auto flex max-w-6xl flex-col items-center justify-between gap-4 px-6 py-6 sm:flex-row">
          <div className="flex items-center gap-2">
            <span className="flex h-7 w-7 items-center justify-center rounded-md bg-primary-500">
              <PenLine className="h-4 w-4 text-white" />
            </span>
            <span className="text-sm font-semibold">Signara</span>
          </div>
          <p className="text-xs text-slate-400">
            Signara · signara.innotel.us · AGPL-3.0 · Part of the Innotel stack
          </p>
        </div>
      </footer>
    </div>
  );
}