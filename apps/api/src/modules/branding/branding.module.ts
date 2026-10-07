import { Module } from '@nestjs/common';
import { BrandingService } from './branding.service';

/**
 * Per-tenant branding (issue #87). Exported because the mailer, the signing
 * page and the evidence report all need to resolve the same values; the module
 * itself imports nothing (PrismaModule is global), so it cannot create a cycle.
 */
@Module({
  providers: [BrandingService],
  exports: [BrandingService],
})
export class BrandingModule {}
