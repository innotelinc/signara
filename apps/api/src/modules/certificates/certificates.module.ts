import { Module } from '@nestjs/common';
import { CertificatesController } from './certificates.controller';
import { CertificatesService } from './certificates.service';
import { AcmeProvider } from './providers/acme.provider';
import { CeruleanProvider } from './providers/cerulean.provider';
import { InternalPkiProvider } from './providers/internal-pki.provider';
import { ProviderRegistry } from './providers/provider-registry';

@Module({
  controllers: [CertificatesController],
  providers: [
    CertificatesService,
    AcmeProvider,
    CeruleanProvider,
    InternalPkiProvider,
    ProviderRegistry,
  ],
  exports: [CertificatesService],
})
export class CertificatesModule {}