/**
 * Authenticated principal attached to `request.user` by the JwtAuthGuard.
 */
export interface AuthenticatedUser {
  /** Local Signara user id (UUID) */
  id: string;
  email: string;
  displayName: string | null;
  platformRole: 'USER' | 'PLATFORM_ADMIN';
  /** IdP subject id (Authentik `sub`) */
  sub: string;
  /** Groups from the IdP token claims */
  groups: string[];
  /** Active tenant context resolved by the guard */
  org?: {
    id: string;
    slug: string;
    role: string;
    /** Permission codes granted to the user's role in this org */
    permissions: string[];
  };
}

export interface RequestWithUser extends Request {
  user?: AuthenticatedUser;
  requestId?: string;
  startTime?: number;
}

export interface PublicSignerContext {
  signerId: string;
  requestId: string;
  email: string;
  role: 'SIGNER' | 'APPROVER' | 'CC';
}