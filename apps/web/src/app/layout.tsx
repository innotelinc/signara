import type { Metadata, Viewport } from 'next';
import { Inter } from 'next/font/google';
import { cookies } from 'next/headers';
import { TokenProvider } from '@/components/token-provider';

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
  const token = cookies().get('signara_access')?.value ?? null;

  return (
    <html lang="en" className={inter.variable}>
      <body className="min-h-screen font-sans">
        <TokenProvider token={token} />
        {children}
      </body>
    </html>
  );
}