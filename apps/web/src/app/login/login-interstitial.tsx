'use client';

import { useEffect, useState } from 'react';
import { PenLine, ShieldCheck, ArrowRight } from 'lucide-react';
import { env } from '@/lib/env';

/** Branded interstitial shown while the browser hops to Authentik. */
export function LoginInterstitial() {
  const [countdown, setCountdown] = useState(3);
  const loginHref = `${env.apiUrl}/api/v1/auth/login?next=/dashboard`;

  useEffect(() => {
    if (countdown <= 0) {
      window.location.assign(loginHref);
      return;
    }
    const timer = setTimeout(() => setCountdown((n) => n - 1), 1000);
    return () => clearTimeout(timer);
  }, [countdown, loginHref]);

  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-ink-950 px-6 text-center">
      <span className="flex h-14 w-14 items-center justify-center rounded-2xl bg-primary-500 shadow-lg">
        <PenLine className="h-7 w-7 text-white" />
      </span>
      <h1 className="mt-6 text-2xl font-bold tracking-tight text-white">Sign in to Signara</h1>
      <p className="mt-2 max-w-sm text-sm text-slate-400">
        Authentication is handled by the Cerulean auth &amp; trust stack. Redirecting
        you to Authentik{countdown > 0 ? ` in ${countdown}…` : '…'}
      </p>

      <div className="mt-6 h-1 w-40 overflow-hidden rounded-full bg-slate-800">
        <div
          className="h-full rounded-full bg-primary-500 transition-all duration-1000 ease-linear"
          style={{ width: `${((3 - countdown) / 3) * 100}%` }}
        />
      </div>

      <a
        href={loginHref}
        className="btn mt-8 bg-primary-500 px-6 py-3 text-white hover:bg-primary-600"
      >
        Continue now
        <ArrowRight className="h-4 w-4" />
      </a>

      <div className="mt-10 flex items-center gap-2 text-xs text-slate-500">
        <ShieldCheck className="h-3.5 w-3.5" />
        Cerulean SSO · signara.innotel.us
      </div>
    </div>
  );
}