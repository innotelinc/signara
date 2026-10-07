import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { Branding, PLATFORM_BRANDING, normalizeBranding } from './branding';

/**
 * Resolves the branding an outbound artefact should carry (issue #87).
 *
 * The lookup is deliberately cheap and one row deep: mail is sent from a queue
 * worker, not a request, and a missing organization (or a deleted one) must not
 * stop a signing mail — it falls back to the platform identity, which is what
 * every deployment sent before this existed.
 */
@Injectable()
export class BrandingService {
  constructor(private readonly prisma: PrismaService) {}

  async forOrganization(organizationId?: string | null): Promise<Branding> {
    if (!organizationId) return PLATFORM_BRANDING;

    const org = await this.prisma.organization.findUnique({
      where: { id: organizationId },
      select: { branding: true, name: true },
    });
    if (!org) return PLATFORM_BRANDING;

    return normalizeBranding(org.branding, org.name);
  }
}
