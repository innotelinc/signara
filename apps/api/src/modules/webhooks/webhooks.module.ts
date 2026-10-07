import { Module } from '@nestjs/common';
import { WebhooksController } from './webhooks.controller';
import { WebhooksService } from './webhooks.service';
import { NotificationsModule } from '../notifications/notifications.module';

/**
 * Outbound signing webhooks. The service is exported because the signing flow
 * emits from inside SignaturesService (see docs/Webhooks.md). Nothing here
 * imports SignaturesModule, so the dependency runs one way.
 *
 * NotificationsModule is imported for the health sweep, which tells the tenant
 * when it disables an endpoint. NotificationsModule imports nothing, so there
 * is no cycle.
 */
@Module({
  imports: [NotificationsModule],
  controllers: [WebhooksController],
  providers: [WebhooksService],
  exports: [WebhooksService],
})
export class WebhooksModule {}
