'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useState } from 'react';
import {
  FileText,
  LayoutDashboard,
  PenLine,
  Settings,
  ShieldCheck,
  LogOut,
  FileSignature,
} from 'lucide-react';
import { cn } from '@/lib/cn';
import { api } from '@/lib/api';

const NAV_ITEMS = [
  { href: '/dashboard', label: 'Dashboard', icon: LayoutDashboard },
  { href: '/documents', label: 'Documents', icon: FileText },
  { href: '/templates', label: 'Templates', icon: FileSignature },
  { href: '/settings', label: 'Settings', icon: Settings },
];

interface Me {
  email: string;
  displayName: string | null;
  platformRole: 'USER' | 'PLATFORM_ADMIN';
  org?: { slug: string; role: string };
}

export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const [me, setMe] = useState<Me | null>(null);

  useEffect(() => {
    api
      .get<Me>('/api/v1/auth/me')
      .then(setMe)
      .catch(() => {
        /* sidebar user block is decorative — the layout guards auth */
      });
  }, []);

  const initials = (me?.displayName || me?.email || '?')
    .split(/[\s@]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase())
    .join('');

  return (
    <div className="flex min-h-screen bg-slate-50">
      <aside className="fixed inset-y-0 left-0 z-20 flex w-60 flex-col border-r border-slate-800 bg-ink-950">
        <Link href="/dashboard" className="flex items-center gap-2.5 px-5 py-5">
          <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-primary-500">
            <PenLine className="h-5 w-5 text-white" />
          </span>
          <div>
            <span className="block text-lg font-bold leading-tight text-white">Signara</span>
            <span className="block text-[11px] font-medium text-slate-500">Secure every signature</span>
          </div>
        </Link>

        <nav className="flex-1 space-y-1 px-3 py-4" aria-label="Main navigation">
          {NAV_ITEMS.map(({ href, label, icon: Icon }) => {
            const active = pathname === href || pathname.startsWith(`${href}/`);
            return (
              <Link
                key={href}
                href={href}
                className={cn(
                  'flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors',
                  active ? 'bg-primary-500 text-white' : 'text-slate-400 hover:bg-slate-800 hover:text-white',
                )}
                aria-current={active ? 'page' : undefined}
              >
                <Icon className="h-4 w-4" />
                {label}
              </Link>
            );
          })}
        </nav>

        <div className="border-t border-slate-800 p-3">
          {me && (
            <div className="mb-2 flex items-center gap-3 rounded-lg px-2 py-2">
              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-primary-500 text-xs font-bold text-white">
                {initials}
              </span>
              <div className="min-w-0">
                <p className="truncate text-sm font-medium text-white">
                  {me.displayName ?? me.email}
                </p>
                <p className="truncate text-xs text-slate-500">
                  {me.org ? `${me.org.slug} · ${me.org.role}` : me.email}
                </p>
              </div>
            </div>
          )}
          <button
            type="button"
            onClick={() => {
              void api.post('/api/v1/auth/logout').finally(() => {
                window.location.assign('/');
              });
            }}
            className="flex w-full items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium text-slate-400 transition-colors hover:bg-slate-800 hover:text-white"
          >
            <LogOut className="h-4 w-4" />
            Sign out
          </button>
        </div>
      </aside>

      <main className="ml-60 flex-1 px-8 py-8">
        <div className="mx-auto max-w-6xl">{children}</div>
      </main>
    </div>
  );
}