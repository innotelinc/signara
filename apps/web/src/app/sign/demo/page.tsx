'use client';

import { useState } from 'react';
import { FileText, ShieldCheck } from 'lucide-react';
import { Badge, Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';

/**
 * Public signing-room demo.
 *
 * The landing page has linked to `/sign/demo` since it was written, but the only
 * route under `sign/` was `sign/[token]` — so "Try a demo signing room" fell
 * through to the token route and asked the API for a signing request named
 * `demo`, which does not exist. This page is the thing that link promised: a
 * self-contained signing room that renders entirely in the browser and sends
 * nothing anywhere, so the demo cannot create a real signing request or leak a
 * visitor's address into an audit trail.
 *
 * It mirrors the real room's shape (document, signer, route, sign/decline) so the
 * demo is representative, but every action is local state.
 */

interface DemoSession {
  title: string;
  message: string;
  deadline: string;
  signer: { name: string; email: string; role: 'SIGNER' | 'APPROVER' };
  document: { fileName: string; pages: number };
  recipients: { initials: string; name: string; role: string; state: 'signed' | 'current' | 'waiting' }[];
}

const DEMO: DemoSession = {
  title: 'Master Service Agreement',
  message: 'Please review and sign by the deadline. Reach out if anything needs changing.',
  deadline: 'In 5 days',
  signer: { name: 'D. Hunter', email: 'dhunter@innotel.us', role: 'SIGNER' },
  document: { fileName: 'Master Service Agreement.pdf', pages: 12 },
  recipients: [
    { initials: 'DH', name: 'D. Hunter', role: 'Signatory', state: 'current' },
    { initials: 'AL', name: 'A. Lopez', role: 'Approver', state: 'waiting' },
    { initials: '+2', name: '2 more recipients', role: 'Ordered workflow', state: 'waiting' },
  ],
};

export default function SignDemoPage() {
  const [done, setDone] = useState<'signed' | 'declined' | null>(null);

  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-50 px-4 py-10">
      <div className="w-full max-w-lg">
        <div className="mb-4 flex items-center justify-between rounded-lg border border-primary-100 bg-primary-50 px-4 py-2.5 text-xs text-primary-700">
          <span className="font-medium">Demo signing room</span>
          <span>Nothing is sent anywhere — try Sign and Decline freely.</span>
        </div>

        {done ? (
          <Card className="w-full">
            <CardContent className="py-10 text-center">
              <ShieldCheck className="mx-auto mb-4 h-12 w-12 text-accent-500" />
              <h1 className="text-xl font-semibold">
                {done === 'signed' ? 'Thank you' : 'Signature declined'}
              </h1>
              <p className="mt-2 text-sm text-slate-500">
                {done === 'signed'
                  ? 'Your response has been recorded. A signed copy and the audit trail are available from the sender.'
                  : 'The sender has been notified. In a real request they can revise the document and send it again.'}
              </p>
              <div className="mt-6 flex justify-center gap-3">
                <Button variant="outline" onClick={() => setDone(null)}>
                  Replay the demo
                </Button>
                <a className="btn-primary" href="/">
                  Back to Signara
                </a>
              </div>
            </CardContent>
          </Card>
        ) : (
          <Card className="w-full">
            <CardHeader>
              <div className="flex items-center gap-3">
                <span className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary-50">
                  <FileText className="h-5 w-5 text-primary-600" />
                </span>
                <div>
                  <CardTitle>{DEMO.title}</CardTitle>
                  <p className="text-xs text-slate-500">
                    For {DEMO.signer.name} · {DEMO.signer.role}
                  </p>
                </div>
              </div>
            </CardHeader>
            <CardContent className="space-y-4">
              <blockquote className="rounded-lg border-l-4 border-primary-500 bg-slate-50 px-4 py-3 text-sm text-slate-600">
                {DEMO.message}
              </blockquote>

              <div className="flex items-center justify-between rounded-lg border border-slate-200 px-4 py-3">
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium">{DEMO.document.fileName}</p>
                  <p className="text-xs text-slate-500">{DEMO.document.pages} pages · securely stored by the sender</p>
                </div>
                <Badge tone="gray">PDF</Badge>
              </div>

              <div className="space-y-2">
                <p className="text-xs font-medium uppercase tracking-wide text-slate-400">Signing order</p>
                {DEMO.recipients.map((r) => (
                  <div
                    key={r.name}
                    className="flex items-center gap-3 rounded-lg border border-slate-200 px-4 py-2.5"
                  >
                    <span className="flex h-8 w-8 items-center justify-center rounded-full bg-slate-100 text-xs font-bold text-slate-600">
                      {r.initials}
                    </span>
                    <div className="flex-1">
                      <p className="text-sm font-medium">{r.name}</p>
                      <p className="text-xs text-slate-500">{r.role}</p>
                    </div>
                    <Badge tone={r.state === 'current' ? 'amber' : 'gray'}>
                      {r.state === 'current' ? 'Your turn' : 'Waiting'}
                    </Badge>
                  </div>
                ))}
              </div>

              <p className="text-xs text-slate-500">Deadline: {DEMO.deadline}</p>

              <div className="flex items-center justify-between gap-3 pt-2">
                <Button variant="danger" onClick={() => setDone('declined')}>
                  Decline
                </Button>
                <Button onClick={() => setDone('signed')}>Sign document</Button>
              </div>

              <div className="flex items-center gap-2 pt-2 text-xs text-slate-400">
                <ShieldCheck className="h-4 w-4" />
                In a real request, your IP address, timestamp, and browser are recorded to the audit trail.
              </div>
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  );
}
