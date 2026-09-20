import { Module } from '@nestjs/common';
import { WebhooksController } from './webhooks.controller';
import { WebhooksService } from './webhooks.service';

/**
 * Outbound signing webhooks. The service is exported because the signing flow
 * emits from inside SignaturesService (see docs/Webhooks.md). Nothing here
 * imports SignaturesModule, so the dependency runs one way.
 */
@Module({
  controllers: [WebhooksController],
  providers: [WebhooksService],
  exports: [WebhooksService],
})
export class WebhooksModule {}
