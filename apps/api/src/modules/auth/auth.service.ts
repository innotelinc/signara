import { Injectable, UnauthorizedException, BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID, createHash } from 'node:crypto';
import jwt from 'jsonwebtoken';
import { PrismaService } from '../../prisma/prisma.service';

interface TokenPair {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}

interface OidcTokenResponse {
  access_token: string;
  refresh_token?: string;
  id_token?: string;
  expires_in: number;
  token_type: string;
}

/**
 * Handles the Authentik (OIDC authorization-code) flow and issues Signara's
 * own short-lived access JWT + rotating refresh token stored as a hashed
 * session (Session table; the raw value only ever lives in an httpOnly cookie).
 */
@Injectable()
export class AuthService {
  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
  ) {}

  buildLoginUrl(state: string): string {
    const params = new URLSearchParams({
      client_id: this.config.get<string>('oidc.clientId') ?? '',
      response_type: 'code',
      scope: (this.config.get<string[]>('oidc.scopes') ?? ['openid', 'profile', 'email']).join(' '),
      redirect_uri: this.config.get<string>('oidc.redirectUri') ?? '',
      state,
    });
    return `${this.config.get<string>('oidc.authorizationUrl')}?${params.toString()}`;
  }

  /** Signs the OIDC state so callbacks cannot forge an arbitrary redirect. */
  createLoginState(next?: string): string {
    const safeNext = this.safeNextPath(next);
    return jwt.sign(
      { next: safeNext, type: 'oidc-state' },
      this.requiredSecret('auth.jwtAccessSecret', 'JWT_ACCESS_SECRET'),
      { expiresIn: '10m', algorithm: 'HS256' },
    );
  }

  /** Verifies and extracts the redirect path from an OIDC callback state. */
  parseLoginState(state: string): string {
    try {
      const payload = jwt.verify(
        state,
        this.requiredSecret('auth.jwtAccessSecret', 'JWT_ACCESS_SECRET'),
        { algorithms: ['HS256'] },
      ) as jwt.JwtPayload & { next?: string; type?: string };
      if (payload.type !== 'oidc-state') throw new Error('invalid state type');
      return this.safeNextPath(payload.next);
    } catch {
      throw new UnauthorizedException('Invalid or expired login state');
    }
  }

  private safeNextPath(next?: string): string {
    if (
      !next ||
      !next.startsWith('/') ||
      next.startsWith('//') ||
      next.includes('\\') ||
      /[\\u0000-\\u001f]/.test(next)
    ) {
      return '/';
    }
    return next;
  }

  /** Exchanges the authorization code at Authentik's token endpoint. */
  async exchangeCode(code: string): Promise<OidcTokenResponse> {
    const tokenUrl = this.config.get<string>('oidc.tokenUrl');
    if (!tokenUrl) {
      throw new UnauthorizedException(
        'Identity provider is not configured (OIDC_TOKEN_URL missing)',
      );
    }
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: this.config.get<string>('oidc.redirectUri') ?? '',
      client_id: this.config.get<string>('oidc.clientId') ?? '',
      client_secret: this.config.get<string>('oidc.clientSecret') ?? '',
    });

    const response = await fetch(tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });
    if (!response.ok) {
      throw new UnauthorizedException('Token exchange with identity provider failed');
    }
    return (await response.json()) as OidcTokenResponse;
  }

  /** Fetches the userinfo endpoint for profile claims. */
  async fetchUserinfo(accessToken: string): Promise<Record<string, unknown>> {
    const response = await fetch(this.config.get<string>('oidc.userinfoUrl') ?? '', {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!response.ok) throw new UnauthorizedException('Failed to fetch user info');
    return (await response.json()) as Record<string, unknown>;
  }

  /**
   * Upserts the local User from IdP claims, issues a token pair and persists
   * the refresh session. New users get the least-privilege USER platform role.
   */
  async loginWithIdp(
    claims: { sub: string; email: string; name?: string; groups?: string[] },
    fingerprint: string,
    ipAddress: string,
  ): Promise<TokenPair> {
    const email = claims.email?.toLowerCase();
    if (!email) throw new BadRequestException('Identity provider response missing email');

    const groups = claims.groups ?? [];
    const platformRole = groups.includes(
      this.config.get<string>('oidc.idpAdminGroup') ?? 'signara-admins',
    )
      ? 'PLATFORM_ADMIN'
      : 'USER';

    const user = await this.prisma.user.upsert({
      where: { email },
      update: {
        authProviderId: claims.sub,
        authProvider: 'authentik',
        displayName: claims.name ?? undefined,
        emailVerifiedAt: new Date(),
        status: 'ACTIVE',
        lastLoginAt: new Date(),
        platformRole: platformRole as 'USER' | 'PLATFORM_ADMIN',
      },
      create: {
        email,
        authProviderId: claims.sub,
        authProvider: 'authentik',
        displayName: claims.name,
        firstName: claims.name?.split(' ')[0],
        lastName: claims.name?.split(' ').slice(1).join(' '),
        emailVerifiedAt: new Date(),
        platformRole: platformRole as 'USER' | 'PLATFORM_ADMIN',
      },
    });

    if (user.status !== 'ACTIVE') {
      throw new UnauthorizedException('Account is not active');
    }

    const pair = this.issueTokenPair(user.id, email);
    await this.createSession(user.id, pair.refreshToken, fingerprint, ipAddress);
    return pair;
  }

  /**
   * Validates the refresh token (hashed with the client fingerprint), revokes
   * the old session and issues a rotated pair with a fresh session.
   */
  async refresh(refreshToken: string, fingerprint: string, ipAddress: string): Promise<TokenPair> {
    let claims: jwt.JwtPayload & { type?: string; sub?: string };
    try {
      claims = jwt.verify(
        refreshToken,
        this.requiredSecret('auth.jwtRefreshSecret', 'JWT_REFRESH_SECRET'),
        { algorithms: ['HS256'] },
      ) as jwt.JwtPayload & { type?: string; sub?: string };
    } catch {
      throw new UnauthorizedException('Invalid or expired refresh token');
    }
    if (claims.type !== 'refresh' || !claims.sub) {
      throw new UnauthorizedException('Invalid refresh token');
    }

    const hash = this.fingerprintHash(fingerprint, refreshToken);
    const session = await this.prisma.session.findFirst({
      where: {
        refreshTokenHash: hash,
        userId: claims.sub,
        revokedAt: null,
        expiresAt: { gt: new Date() },
      },
      include: { user: true },
    });
    if (!session) throw new UnauthorizedException('Invalid or expired refresh token');

    if (session.user.status !== 'ACTIVE') throw new UnauthorizedException('Account is not active');

    const revoked = await this.prisma.session.updateMany({
      where: { id: session.id, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    if (revoked.count !== 1) throw new UnauthorizedException('Invalid or expired refresh token');

    const pair = this.issueTokenPair(session.userId, session.user.email);
    await this.createSession(session.userId, pair.refreshToken, fingerprint, ipAddress);
    return pair;
  }

  async revokeSession(refreshToken: string, fingerprint: string): Promise<void> {
    const hash = this.fingerprintHash(fingerprint, refreshToken);
    await this.prisma.session.updateMany({
      where: { refreshTokenHash: hash },
      data: { revokedAt: new Date() },
    });
  }

  async logoutAll(userId: string): Promise<void> {
    await this.prisma.session.updateMany({ where: { userId }, data: { revokedAt: new Date() } });
  }

  async createSession(
    userId: string,
    refreshToken: string,
    fingerprint: string,
    ipAddress: string,
  ): Promise<void> {
    await this.prisma.session.create({
      data: {
        userId,
        refreshTokenHash: this.fingerprintHash(fingerprint, refreshToken),
        expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
        ipAddress,
      },
    });
  }

  private issueTokenPair(userId: string, email: string): TokenPair {
    const accessSecret = this.requiredSecret('auth.jwtAccessSecret', 'JWT_ACCESS_SECRET');
    const refreshSecret = this.requiredSecret('auth.jwtRefreshSecret', 'JWT_REFRESH_SECRET');
    const accessExpiresIn = 15 * 60; // seconds

    const accessToken = jwt.sign(
      { sub: userId, email, type: 'access', jti: randomUUID() },
      accessSecret,
      { expiresIn: accessExpiresIn, algorithm: 'HS256' },
    );
    const refreshToken = jwt.sign(
      { sub: userId, email, type: 'refresh', jti: randomUUID() },
      refreshSecret,
      { expiresIn: '30d', algorithm: 'HS256' },
    );

    return { accessToken, refreshToken, expiresIn: accessExpiresIn };
  }

  private fingerprintHash(fingerprint: string, refreshToken: string): string {
    return createHash('sha256').update(`${fingerprint}:${refreshToken}`).digest('hex');
  }

  private requiredSecret(key: string, envName: string): string {
    const value = this.config.get<string>(key);
    if (!value) {
      throw new Error(`Missing ${envName} — set it in .env`);
    }
    return value;
  }
}
