import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { createHash, randomBytes } from 'node:crypto';
import { PrismaService } from '../../prisma/prisma.service';
import { AuthenticatedUser } from '../../common/types';

@Injectable()
export class ApiKeysService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Creates an API key. The plaintext is returned exactly once; only the
   * SHA-256 hash is stored. Scope strings map to permission codes.
   */
  async create(user: AuthenticatedUser, data: { name: string; scopes?: string[]; expiresInDays?: number }) {
    const orgId = user.org?.id;
    if (!orgId) throw new ForbiddenException('No active tenant');

    const plaintext = `sgn_${randomBytes(28).toString('base64url')}`;
    const prefix = plaintext.slice(0, 10);
    const keyHash = createHash('sha256').update(plaintext).digest('hex');

    const apiKey = await this.prisma.apiKey.create({
      data: {
        organizationId: orgId,
        userId: user.id,
        name: data.name,
        keyHash,
        prefix,
        scopes: data.scopes ?? [],
        expiresAt: data.expiresInDays ? new Date(Date.now() + data.expiresInDays * 24 * 60 * 60 * 1000) : null,
      },
    });

    return { id: apiKey.id, name: apiKey.name, prefix, scopes: apiKey.scopes, expiresAt: apiKey.expiresAt, createdAt: apiKey.createdAt, key: plaintext };
  }

  async list(user: AuthenticatedUser) {
    const orgId = user.org?.id!;
    return this.prisma.apiKey.findMany({
      where: { organizationId: orgId, revokedAt: null },
      select: { id: true, name: true, prefix: true, scopes: true, expiresAt: true, lastUsedAt: true, createdAt: true },
      orderBy: { createdAt: 'desc' },
    });
  }

  async revoke(user: AuthenticatedUser, id: string) {
    const orgId = user.org?.id!;
    const key = await this.prisma.apiKey.findFirst({ where: { id, organizationId: orgId } });
    if (!key) throw new NotFoundException('API key not found');
    await this.prisma.apiKey.update({ where: { id }, data: { revokedAt: new Date() } });
    return { success: true };
  }
}