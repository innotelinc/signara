'use client';

import { useEffect } from 'react';
import { setAccessToken } from '@/lib/api';

/**
 * Relays the httpOnly access-token cookie (read server-side in layout.tsx)
 * into a meta tag the client-side API wrapper can read. Re-synced when the
 * token changes (e.g. after a refresh round trip).
 */
export function TokenProvider({ token }: { token: string | null }) {
  useEffect(() => {
    setAccessToken(token);
  }, [token]);

  return <meta name="access-token" content={token ?? ''} />;
}
