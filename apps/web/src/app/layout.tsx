import type { Metadata, Viewport } from 'next';
import { Inter } from 'next/font/google';
import { cookies, headers } from 'next/headers';
import { LocaleProvider } from '@/components/i18n/locale-provider';
import { TokenProvider } from '@/components/token-provider';
import { LOCALE_COOKIE, resolveLocale } from '@/lib/i18n/config';
import { loadMessages } from '@/lib/i18n/server';
import './globals.css';

const inter = Inter({ subsets: ['latin'], variable: '--font-inter' });

export const metadata: Metadata = {
  title: { default: 'Signara — Secure Every Signature', template: '%s · Signara' },
  description:
    'Open-source digital document signing and agreement management. Self-hosted, multi-tenant, Authentik-native, audit-ready.',
  metadataBase: new URL(process.env.NEXT_PUBLIC_WEB_URL ?? 'http://localhost:3000'),
  openGraph: { title: 'Signara', description: 'Secure Every Signature.', type: 'website' },
};

export const viewport: Viewport = {
  themeColor: '#0F62FE',
  width: 'device-width',
  initialScale: 1,
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  // The access token lives in an httpOnly cookie; relay it to the client via a
  // meta tag so the API client can attach it without JS reading the cookie.
  const cookieStore = cookies();
  const token = cookieStore.get('signara_access')?.value ?? null;

  // A stored language choice wins over the browser's; either way the catalog is
  // loaded server-side so the first paint is already in the right language.
  const locale = resolveLocale(
    cookieStore.get(LOCALE_COOKIE)?.value,
    headers().get('accept-language'),
  );
  const messages = loadMessages(locale);

  return (
    <html lang={locale} className={inter.variable}>
      <body className="min-h-screen font-sans">
        <TokenProvider token={token} />
        <LocaleProvider locale={locale} messages={messages}>
          {children}
        </LocaleProvider>
      </body>
    </html>
  );
}