'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useState, useSyncExternalStore } from 'react';
import {
  FileText,
  LayoutDashboard,
  PenLine,
  Settings,
  ShieldCheck,
  LogOut,
  FileSignature,
  Menu,
  X,
  PanelLeftClose,
  PanelLeftOpen,
} from 'lucide-react';
import { cn } from '@/lib/cn';
import { api } from '@/lib/api';

const NAV_ITEMS = [
  { href: '/dashboard', label: 'Dashboard', icon: LayoutDashboard },
  { href: '/documents', label: 'Documents', icon: FileText },
  { href: '/templates', label: 'Templates', icon: FileSignature },
  { href: '/settings', label: 'Settings', icon: Settings },
];

const DESKTOP_QUERY = '(min-width: 1024px)';

interface Me {
  email: string;
  displayName: string | null;
  platformRole: 'USER' | 'PLATFORM_ADMIN';
  org?: { slug: string; role: string };
}

export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const [me, setMe] = useState<Me | null>(null);

  // Auto-collapse: below lg the sidebar is an off-canvas drawer (closed by
  // default, sliding out to the left). On lg+ it is a pinned rail that the
  // user can collapse with the chevron.
  //
  // The media query is read through useSyncExternalStore so the server and
  // the client's first (hydration) render agree — reading matchMedia in a
  // useState initializer caused React hydration mismatches (#418/#423) on
  // every authenticated page when the viewport disagreed with the SSR guess.
  const subscribeMedia = (onChange: () => void) => {
    const mq = window.matchMedia(DESKTOP_QUERY);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  };
  const isDesktop = useSyncExternalStore(
    subscribeMedia,
    () => window.matchMedia(DESKTOP_QUERY).matches,
    () => true, // server snapshot: match the SSR desktop layout, then correct on mount
  );
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(false);

  // When the viewport crosses onto desktop, snap the drawer shut so the
  // pinned rail state is deterministic.
  useEffect(() => {
    if (isDesktop) setDrawerOpen(false);
  }, [isDesktop]);

  useEffect(() => {
    api
      .get<Me>('/api/v1/auth/me')
      .then(setMe)
      .catch(() => {
        /* sidebar user block is decorative — the layout guards auth */
      });
  }, []);

  const railHidden = isDesktop ? collapsed : !drawerOpen;

  const initials = (me?.displayName || me?.email || '?')
    .split(/[\s@]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase())
    .join('');

  return (
    <div className="min-h-screen bg-slate-50">
      {/* Mobile top bar */}
      <header className="sticky top-0 z-30 flex items-center gap-3 border-b border-slate-800 bg-ink-950 px-4 py-3 lg:hidden">
        <button
          type="button"
          onClick={() => setDrawerOpen((v) => !v)}
          className="flex h-9 w-9 items-center justify-center rounded-lg text-slate-300 transition-colors hover:bg-slate-800 hover:text-white"
          aria-label={drawerOpen ? 'Close navigation' : 'Open navigation'}
        >
          {drawerOpen ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
        </button>
        <Link href="/dashboard" className="flex items-center gap-2">
          <span className="flex h-7 w-7 items-center justify-center rounded-md bg-primary-500">
            <PenLine className="h-4 w-4 text-white" />
          </span>
          <span className="text-base font-bold text-white">Signara</span>
        </Link>
      </header>

      {/* Mobile backdrop */}
      {!isDesktop && drawerOpen && (
        <div
          className="fixed inset-0 z-40 bg-ink-950/60 backdrop-blur-sm lg:hidden"
          onClick={() => setDrawerOpen(false)}
          aria-hidden
        />
      )}

      {/* Sidebar — slides off-canvas to the left when auto-collapsed */}
      <aside
        className={cn(
          'fixed inset-y-0 left-0 z-50 flex w-60 flex-col border-r border-slate-800 bg-ink-950 transition-transform duration-200 ease-in-out',
          railHidden ? '-translate-x-full' : 'translate-x-0',
          // Desktop pinned rail keeps its own collapse state; translate the
          // drawer transforms above so the two never fight.
          isDesktop && collapsed && 'lg:-translate-x-full',
          isDesktop && !collapsed && 'lg:translate-x-0',
        )}
        aria-hidden={railHidden}
      >
        <div className="flex items-center justify-between px-5 py-5">
          <Link href="/dashboard" className="flex items-center gap-2.5">
            <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-primary-500">
              <PenLine className="h-5 w-5 text-white" />
            </span>
            <div>
              <span className="block text-lg font-bold leading-tight text-white">Signara</span>
              <span className="block text-[11px] font-medium text-slate-500">
                Secure every signature
              </span>
            </div>
          </Link>
          {/* Close drawer on mobile; collapse the pinned rail on desktop */}
          {!isDesktop ? (
            <button
              type="button"
              onClick={() => setDrawerOpen(false)}
              className="flex h-8 w-8 items-center justify-center rounded-lg text-slate-400 hover:bg-slate-800 hover:text-white lg:hidden"
              aria-label="Close navigation"
            >
              <X className="h-4 w-4" />
            </button>
          ) : (
            <button
              type="button"
              onClick={() => setCollapsed((v) => !v)}
              className="flex h-8 w-8 items-center justify-center rounded-lg text-slate-400 transition-colors hover:bg-slate-800 hover:text-white"
              aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
              title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
            >
              {collapsed ? <PanelLeftOpen className="h-4 w-4" /> : <PanelLeftClose className="h-4 w-4" />}
            </button>
          )}
        </div>

        <nav className="flex-1 space-y-1 px-3 py-4" aria-label="Main navigation">
          {NAV_ITEMS.map(({ href, label, icon: Icon }) => {
            const active = pathname === href || pathname.startsWith(`${href}/`);
            return (
              <Link
                key={href}
                href={href}
                onClick={() => !isDesktop && setDrawerOpen(false)}
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

      {/* Floating expand button when the desktop rail is collapsed */}
      {isDesktop && collapsed && (
        <button
          type="button"
          onClick={() => setCollapsed(false)}
          className="fixed left-4 top-4 z-40 flex h-9 w-9 items-center justify-center rounded-lg border border-slate-200 bg-white text-slate-600 shadow-card transition-colors hover:text-primary-600"
          aria-label="Expand sidebar"
          title="Expand sidebar"
        >
          <PanelLeftOpen className="h-4 w-4" />
        </button>
      )}

      <main
        className={cn(
          'flex-1 px-4 py-6 sm:px-8 sm:py-8',
          isDesktop && (collapsed ? 'lg:ml-16' : 'lg:ml-60'),
        )}
      >
        <div className="mx-auto max-w-6xl">{children}</div>
      </main>
    </div>
  );
}
