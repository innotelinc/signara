import { Module } from '@nestjs/common';
import { NotificationProcessor } from './notification.processor';
import { SigningProcessor } from './signing.processor';
import { QueueMetricsService } from './queue-metrics.service';
import { MailerModule } from '../mailer/mailer.module';

/**
 * BullMQ workers. Processors run in the API process; for higher throughput,
 * scale these out as separate Compose worker services when required.
 */
@Module({
  imports: [MailerModule],
  providers: [NotificationProcessor, SigningProcessor, QueueMetricsService],
})
export class JobsModule {}
