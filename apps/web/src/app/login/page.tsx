import type { Metadata } from 'next';
import { LoginInterstitial } from './login-interstitial';

export const metadata: Metadata = { title: 'Sign in' };

export default function LoginPage() {
  // The identity provider flow is delegated to the API: the interstitial
  // auto-redirects to GET /api/v1/auth/login, which bounces to Authentik,
  // and the callback establishes the session cookies.
  return <LoginInterstitial />;
}