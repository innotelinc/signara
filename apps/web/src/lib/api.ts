import { env } from './env';

export class ApiError extends Error {
  constructor(
    public status: number,
    public message: string,
    public details?: string[],
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  body?: unknown;
  headers?: Record<string, string>;
  signal?: AbortSignal;
  /** Set false to skip the automatic retry-on-refresh round trip. */
  retry?: boolean;
}

/**
 * Fetch wrapper:
 *  - attaches the bearer token relayed server-side (meta tag, set by
 *    <TokenProvider/>) or the Authorization header
 *  - transparently refreshes the session once on 401
 *  - normalizes error responses into ApiError
 */
export async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const { method = 'GET', body, headers, signal, retry = true } = options;

  const token = getAccessToken();

  const response = await fetch(`${env.apiUrl}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal,
    credentials: 'include' as RequestCredentials,
  });

  if (response.status === 401 && retry) {
    const refreshed = await refreshSession();
    if (refreshed) {
      return request<T>(path, { ...options, retry: false });
    }
  }

  if (!response.ok) {
    const payload = (await response.json().catch(() => null)) as {
      message?: string | string[];
    } | null;
    const message = Array.isArray(payload?.message)
      ? (payload as { message: string[] }).message.join('; ')
      : (payload?.message as string | undefined) ?? `Request failed with status ${response.status}`;
    throw new ApiError(response.status, message, Array.isArray(payload?.message) ? (payload as { message: string[] }).message : undefined);
  }

  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

/** Reads the access token from the relay meta tag (httpOnly cookie bytes). */
function getAccessToken(): string | null {
  if (typeof window === 'undefined') return null;
  return document.querySelector<HTMLMetaElement>('meta[name="access-token"]')?.content || null;
}

async function refreshSession(): Promise<boolean> {
  try {
    const response = await fetch(`${env.apiUrl}/api/v1/auth/refresh`, {
      method: 'POST',
      credentials: 'include',
    });
    if (!response.ok) return false;
    const { accessToken } = (await response.json()) as { accessToken: string };
    const meta = document.querySelector<HTMLMetaElement>('meta[name="access-token"]');
    if (meta) meta.content = accessToken;
    return true;
  } catch {
    return false;
  }
}

export function setAccessToken(token: string | null): void {
  const meta = document.querySelector<HTMLMetaElement>('meta[name="access-token"]');
  if (meta) meta.content = token ?? '';
}

export const api = {
  get: <T>(path: string, options?: RequestOptions) => request<T>(path, { ...options, method: 'GET' }),
  post: <T>(path: string, body?: unknown, options?: RequestOptions) =>
    request<T>(path, { ...options, method: 'POST', body }),
  patch: <T>(path: string, body?: unknown, options?: RequestOptions) =>
    request<T>(path, { ...options, method: 'PATCH', body }),
  del: <T>(path: string, options?: RequestOptions) => request<T>(path, { ...options, method: 'DELETE' }),
};