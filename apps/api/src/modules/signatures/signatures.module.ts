import { Module } from '@nestjs/common';
import { CertificatesModule } from '../certificates/certificates.module';
import { WebhooksModule } from '../webhooks/webhooks.module';
import { SignaturesController } from './signatures.controller';
import { SignaturesService } from './signatures.service';

@Module({
  imports: [CertificatesModule, WebhooksModule],
  controllers: [SignaturesController],
  providers: [SignaturesService],
  exports: [SignaturesService],
})
export class SignaturesModule {}