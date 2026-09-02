import { redirect } from 'next/navigation';
import { env } from '@/lib/env';

export default function LoginPage() {
  // The identity provider flow is delegated entirely to the API:
  // GET /api/v1/auth/login redirects to Authentik, and the callback
  // establishes the session cookies.
  redirect(`${env.apiUrl}/api/v1/auth/login?next=/dashboard`);
}