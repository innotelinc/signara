'use client';

import { useState } from 'react';
import Link from 'next/link';
import { CheckCircle2, FileText, ShieldCheck, XCircle } from 'lucide-react';
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
 * demo is representative, but every action is local state. Signing ends the way
 * a real request ends — on the *document*: the signature lands in the page's
 * signature block and a completion record is shown beside it. A demo that only
 * printed "Thank you" demonstrated the mail, not the product.
 */

interface DemoRecipient {
  initials: string;
  name: string;
  role: string;
  /** Signed earlier in the route, or the visitor's own open turn. */
  state: 'signed' | 'current';
  signedOn: string | null;
}

const DEMO = {
  requestId: 'req_demo_7f21c4',
  title: 'Master Service Agreement',
  message: 'Please review and sign by the deadline. Reach out if anything needs changing.',
  deadline: 'In 5 days',
  document: { fileName: 'Master Service Agreement.pdf', pages: 12, size: '248 KB' },
  signer: { name: 'D. Hunter', email: 'dhunter@innotel.us', role: 'SIGNER' as const },
  signerIndex: 2,
  route: [
    { initials: 'AL', name: 'A. Lopez', role: 'Approver', state: 'signed', signedOn: '2 days ago' },
    { initials: 'MR', name: 'M. Reyes', role: 'Signatory', state: 'signed', signedOn: 'Yesterday' },
    { initials: 'DH', name: 'D. Hunter (you)', role: 'Signatory', state: 'current', signedOn: null },
  ] as DemoRecipient[],
  /** Sample values, so the record has the shape a real one does. */
  sample: {
    ip: '203.0.113.42',
    hash: '9f2c4b7e18a5…c3d1',
    certificateId: 'OPS-DEMO-4471',
  },
};

/**
 * The signing order as the demo shows it: before signing, the visitor's row is
 * still open; after, it carries their signature and the request has completed.
 * Split out from the page so it can be asserted without a browser.
 */
export function routeAfter(
  route: DemoRecipient[],
  completed: boolean,
  signedOn = 'Just now',
): DemoRecipient[] {
  return route.map((r) =>
    completed && r.state === 'current' ? { ...r, state: 'signed', signedOn } : r,
  );
}

/**
 * Page 1 of the agreement, drawn in the browser rather than rendered from a
 * file. The signature block is the point: empty before signing, filled with the
 * visitor's typed signature after — which is what the signed copy looks like.
 */
export function DocumentPage({ signature }: { signature: { name: string; at: Date } | null }) {
  const lines = [100, 93, 97, 62, 100, 90, 96, 84];

  return (
    <div className="rounded-lg border border-slate-200 bg-white px-5 py-5 shadow-sm">
      <div className="flex items-start justify-between gap-3 border-b border-slate-200 pb-3">
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">
            {DEMO.title}
          </p>
          <p className="mt-0.5 text-[11px] text-slate-400">
            Innotel Inc. · Page 1 of {DEMO.document.pages} · {DEMO.document.size}
          </p>
        </div>
        <Badge tone={signature ? 'green' : 'gray'}>{signature ? 'Signed' : 'Unsigned'}</Badge>
      </div>

      <div className="mt-4 space-y-2" aria-hidden>
        <p className="text-xs font-semibold text-slate-700">1. Term and scope</p>
        {lines.slice(0, 4).map((width, i) => (
          <span key={i} className="block h-2 rounded-sm bg-slate-100" style={{ width: `${width}%` }} />
        ))}
        <p className="pt-2 text-xs font-semibold text-slate-700">2. Signature</p>
        {lines.slice(4).map((width, i) => (
          <span key={i} className="block h-2 rounded-sm bg-slate-100" style={{ width: `${width}%` }} />
        ))}
      </div>

      <div className="mt-5 grid grid-cols-1 gap-4 border-t border-dashed border-slate-300 pt-4 sm:grid-cols-2">
        <div>
          <p className="text-[10px] font-semibold uppercase tracking-wider text-slate-400">
            Signature
          </p>
          {signature ? (
            <p className="mt-1 font-serif text-2xl italic text-primary-700">{signature.name}</p>
          ) : (
            <p className="mt-1 border-b border-dashed border-slate-300 pb-3 text-xs text-slate-300">
              Sign here
            </p>
          )}
          <p className="mt-1 text-[11px] text-slate-500">
            {DEMO.signer.name} · {DEMO.signer.email}
          </p>
        </div>
        <div>
          <p className="text-[10px] font-semibold uppercase tracking-wider text-slate-400">
            Signed on
          </p>
          <p className="mt-1 text-sm text-slate-700">
            {signature ? signature.at.toLocaleString() : '—'}
          </p>
          <p className="mt-1 text-[11px] text-slate-500">
            {signature
              ? 'Typed signature, timestamped and bound to the document hash'
              : 'Your name and the time are recorded when you sign'}
          </p>
        </div>
      </div>
    </div>
  );
}

function RecipientRow({ recipient }: { recipient: DemoRecipient }) {
  const signed = recipient.state === 'signed';
  return (
    <div className="flex items-center gap-3 rounded-lg border border-slate-200 px-4 py-2.5">
      <span className="flex h-8 w-8 items-center justify-center rounded-full bg-slate-100 text-xs font-bold text-slate-600">
        {recipient.initials}
      </span>
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium">{recipient.name}</p>
        <p className="text-xs text-slate-500">
          {recipient.role}
          {recipient.signedOn ? ` · signed ${recipient.signedOn}` : ''}
        </p>
      </div>
      <Badge tone={signed ? 'green' : 'amber'}>{signed ? 'Signed' : 'Your turn'}</Badge>
    </div>
  );
}

/**
 * The room itself. The route mounts it in the waiting state; the seeded outcome
 * exists so the completed and declined screens can be rendered in tests.
 */
export function DemoRoom({
  initialOutcome = null,
}: {
  initialOutcome?: 'signed' | 'declined' | null;
}) {
  const [outcome, setOutcome] = useState<'signed' | 'declined' | null>(initialOutcome);
  const [signedAt, setSignedAt] = useState<Date | null>(null);

  function sign() {
    const now = new Date();
    setSignedAt(now);
    setOutcome('signed');
  }

  function reset() {
    setSignedAt(null);
    setOutcome(null);
  }

  const completed = outcome === 'signed';
  const route = routeAfter(DEMO.route, completed);
  const signedCount = route.filter((r) => r.state === 'signed').length;

  return (
    <div className="min-h-screen bg-slate-50 px-4 py-10">
      <div className={completed ? 'mx-auto w-full max-w-3xl' : 'mx-auto w-full max-w-lg'}>
        <div className="mb-4 flex flex-wrap items-center justify-between gap-2 rounded-lg border border-primary-100 bg-primary-50 px-4 py-2.5 text-xs text-primary-700">
          <span className="font-medium">Demo signing room</span>
          <span>Sample data — nothing is sent anywhere. Sign and decline as often as you like.</span>
        </div>

        {outcome === 'declined' ? (
          <Card className="w-full">
            <CardContent className="py-10 text-center">
              <XCircle className="mx-auto mb-4 h-12 w-12 text-red-500" />
              <h1 className="text-xl font-semibold">Signature declined</h1>
              <p className="mx-auto mt-2 max-w-md text-sm text-slate-500">
                The sender has been notified and the request stays open ({signedCount} of{' '}
                {route.length} signed). In a real request they can revise the document and send it
                again.
              </p>
              <div className="mt-6 flex justify-center gap-3">
                <Button variant="outline" onClick={reset}>
                  Replay the demo
                </Button>
                <Link href="/" className="btn-primary">
                  Back to Signara
                </Link>
              </div>
            </CardContent>
          </Card>
        ) : completed ? (
          <div className="space-y-4">
            <Card>
              <CardContent className="flex flex-wrap items-center gap-4">
                <span className="flex h-11 w-11 items-center justify-center rounded-full bg-emerald-50">
                  <CheckCircle2 className="h-6 w-6 text-emerald-600" />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <h1 className="text-lg font-semibold">Signing complete</h1>
                    <Badge tone="green">COMPLETED</Badge>
                  </div>
                  <p className="mt-0.5 text-sm text-slate-500">
                    You were the last signature on {DEMO.requestId}. Every recipient has signed, so
                    the request is sealed and this is the document of record.
                  </p>
                </div>
              </CardContent>
            </Card>

            <div className="grid grid-cols-1 gap-4 lg:grid-cols-5">
              <div className="lg:col-span-3">
                <p className="mb-2 text-xs font-medium uppercase tracking-wide text-slate-400">
                  Signed copy
                </p>
                <DocumentPage signature={{ name: DEMO.signer.name, at: signedAt ?? new Date() }} />
              </div>

              <div className="space-y-4 lg:col-span-2">
                <Card>
                  <CardHeader>
                    <CardTitle>Signatures</CardTitle>
                    <Badge tone="green">
                      {signedCount}/{route.length}
                    </Badge>
                  </CardHeader>
                  <CardContent className="space-y-2">
                    {route.map((recipient) => (
                      <RecipientRow key={recipient.name} recipient={recipient} />
                    ))}
                  </CardContent>
                </Card>

                <Card>
                  <CardHeader>
                    <CardTitle>Completion record</CardTitle>
                  </CardHeader>
                  <CardContent>
                    <dl className="space-y-2 text-sm">
                      <div className="flex justify-between gap-4">
                        <dt className="text-slate-500">Request</dt>
                        <dd className="font-mono text-xs">{DEMO.requestId}</dd>
                      </div>
                      <div className="flex justify-between gap-4">
                        <dt className="text-slate-500">Certificate</dt>
                        <dd className="font-mono text-xs">{DEMO.sample.certificateId}</dd>
                      </div>
                      <div className="flex justify-between gap-4">
                        <dt className="text-slate-500">Completed</dt>
                        <dd className="text-right">
                          {(signedAt ?? new Date()).toLocaleString()}
                        </dd>
                      </div>
                      <div className="flex justify-between gap-4">
                        <dt className="text-slate-500">Signed from</dt>
                        <dd className="font-mono text-xs">{DEMO.sample.ip}</dd>
                      </div>
                      <div className="flex justify-between gap-4">
                        <dt className="text-slate-500">Document SHA-256</dt>
                        <dd className="font-mono text-xs">{DEMO.sample.hash}</dd>
                      </div>
                    </dl>
                  </CardContent>
                </Card>

                <div className="flex flex-wrap gap-3">
                  <Button variant="outline" onClick={reset}>
                    Replay the demo
                  </Button>
                  <Link href="/" className="btn-primary">
                    Back to Signara
                  </Link>
                </div>
              </div>
            </div>

            <div className="flex items-start gap-2 text-xs text-slate-400">
              <ShieldCheck className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              In a real request the IP, timestamp, document hash and certificate are appended to an
              audit trail the sender can export. This page is the demo — it holds sample values and
              never left your browser.
            </div>
          </div>
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

              <DocumentPage signature={null} />

              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <p className="text-xs font-medium uppercase tracking-wide text-slate-400">
                    Signing order
                  </p>
                  <span className="text-xs text-slate-400">
                    {signedCount} of {route.length} signed
                  </span>
                </div>
                {route.map((recipient) => (
                  <RecipientRow key={recipient.name} recipient={recipient} />
                ))}
                <p className="text-xs text-slate-500">
                  You&apos;re the last signature — once you sign, the request completes.
                </p>
              </div>

              <p className="text-xs text-slate-500">Deadline: {DEMO.deadline}</p>

              {/*
                Signing a name is all this demo asks for; the real room renders
                whatever fields the sender placed on the document (signature,
                initials, date, dropdowns, and so on). Saying so is better than
                showing an input that pretends to be one.
              */}
              <p className="rounded-lg border border-slate-200 bg-slate-50 px-4 py-3 text-xs text-slate-500">
                In the real signing room, the fields the sender placed — signature, initials, date,
                dropdowns — appear here for you to fill.
              </p>

              <div className="flex items-center justify-between gap-3 pt-2">
                <Button variant="danger" onClick={() => setOutcome('declined')}>
                  Decline
                </Button>
                <Button onClick={sign}>Sign document</Button>
              </div>

              <div className="flex items-center gap-2 pt-2 text-xs text-slate-400">
                <ShieldCheck className="h-4 w-4" />
                In a real request, your IP address, timestamp, and browser are recorded to the audit
                trail.
              </div>
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  );
}

/** `/sign/demo` — always the waiting state; signing moves the room's own state. */
export default function SignDemoPage() {
  return <DemoRoom />;
}
