import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { JwksClient } from 'jwks-rsa';
import jwt from 'jsonwebtoken';
import { PrismaService } from '../../prisma/prisma.service';
import { IS_PUBLIC_KEY } from '../decorators';
import { AuthenticatedUser } from '../types';

interface IdpTokenPayload {
  sub: string;
  iss?: string;
  aud?: string | string[];
  email?: string;
  preferred_username?: string;
  name?: string;
  groups?: string[];
  exp?: number;
  iat?: number;
}

/**
 * Validates the bearer token issued by Authentik (RS256, key sourced from the
 * OIDC JWKS endpoint) and resolves the local User + active tenant context.
 */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  private jwks: JwksClient;

  constructor(
    private readonly reflector: Reflector,
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
  ) {
    const jwksUrl = this.config.get<string>('oidc.jwksUrl') ?? '';
    if (!jwksUrl) {
      throw new Error('OIDC_JWKS_URL is not configured');
    }
    this.jwks = new JwksClient({
      jwksUri: jwksUrl,
      cache: true,
      rateLimit: true,
      jwksRequestsPerMinute: 10,
    });
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    const request = context.switchToHttp().getRequest();

    // API-key authentication for machine clients
    const apiKey = request.headers['x-api-key'] as string | undefined;
    if (apiKey) {
      const principal = await this.authenticateApiKey(apiKey);
      request.user = principal;
      return true;
    }

    if (isPublic) {
      return true;
    }

    const token = this.extractBearer(request.headers.authorization);
    if (!token) {
      throw new UnauthorizedException('Missing bearer token');
    }

    request.user = await this.resolvePrincipal(token);
    return true;
  }

  private extractBearer(authorization: string | undefined): string | undefined {
    if (!authorization?.startsWith('Bearer ')) return undefined;
    return authorization.slice('Bearer '.length).trim();
  }

  /** Verifies the IdP JWT and maps it onto a local Signara user. */
  private async resolvePrincipal(token: string): Promise<AuthenticatedUser> {
    const issuer = this.config.get<string>('oidc.issuerUrl');
    let payload: IdpTokenPayload;
    try {
      const decoded = jwt.decode(token, { complete: true }) as jwt.Jwt | null;
      if (!decoded) throw new Error('unable to decode token');
      const kid = decoded.header.kid;
      const key = await this.jwks.getSigningKey(kid);
      payload = jwt.verify(token, key.getPublicKey(), {
        algorithms: ['RS256'],
        issuer: issuer || undefined,
      }) as IdpTokenPayload;
    } catch (err) {
      throw new UnauthorizedException('Invalid or expired token');
    }

    if (!payload.sub || !payload.email) {
      throw new UnauthorizedException('Token missing required claims (sub, email)');
    }

    const user = await this.prisma.user.findFirst({
      where: {
        OR: [{ authProviderId: payload.sub }, { email: payload.email }],
        status: 'ACTIVE',
        deletedAt: null,
      },
    });
    if (!user) {
      throw new UnauthorizedException('User is not provisioned. Ask your administrator to invite you.');
    }

    const principal: AuthenticatedUser = {
      id: user.id,
      email: user.email,
      displayName: user.displayName,
      platformRole: user.platformRole,
      sub: payload.sub,
      groups: payload.groups ?? [],
    };

    // Resolve the active tenant: explicit claim > first membership
    const membership = await this.prisma.membership.findFirst({
      where: { userId: user.id, organization: { status: { in: ['ACTIVE', 'TRIAL'] } } },
      orderBy: { createdAt: 'asc' },
      include: {
        organization: { select: { id: true, slug: true } },
        roleRef: { include: { permissions: { include: { permission: true } } } },
      },
    });

    if (membership) {
      principal.org = {
        id: membership.organization.id,
        slug: membership.organization.slug,
        role: membership.role,
        permissions: membership.roleRef?.permissions.map((rp) => rp.permission.code) ?? [],
      };
    }

    void this.prisma.user
      .update({ where: { id: user.id }, data: { lastLoginAt: new Date() } })
      .catch(() => undefined);

    return principal;
  }

  /** Authenticates an `X-API-Key` against the ApiKey table (SHA-256 compared). */
  private async authenticateApiKey(rawKey: string): Promise<AuthenticatedUser> {
    const crypto = await import('node:crypto');
    const keyHash = crypto.createHash('sha256').update(rawKey).digest('hex');
    const apiKeyRow = await this.prisma.apiKey.findFirst({
      where: { keyHash, revokedAt: null, OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }] },
    });
    if (!apiKeyRow) {
      throw new UnauthorizedException('Invalid API key');
    }
    void this.prisma.apiKey
      .update({ where: { id: apiKeyRow.id }, data: { lastUsedAt: new Date() } })
      .catch(() => undefined);

    const user = await this.prisma.user.findFirst({
      where: { id: apiKeyRow.userId ?? '', status: 'ACTIVE' },
    });

    return {
      id: apiKeyRow.userId ?? 'system',
      email: user?.email ?? `apikey:${apiKeyRow.prefix}`,
      displayName: apiKeyRow.name,
      platformRole: 'USER',
      sub: `apikey:${apiKeyRow.id}`,
      groups: [],
      org: user
        ? {
            id: apiKeyRow.organizationId,
            slug: '',
            role: 'API_KEY',
            permissions: apiKeyRow.scopes,
          }
        : undefined,
    };
  }
}