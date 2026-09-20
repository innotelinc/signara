import { Module } from '@nestjs/common';
import { NotificationProcessor } from './notification.processor';
import { SigningProcessor } from './signing.processor';
import { ReminderSchedulerService } from './reminder-scheduler.service';
import { QueueMetricsService } from './queue-metrics.service';
import { MailerModule } from '../mailer/mailer.module';
import { SignaturesModule } from '../signatures/signatures.module';

/**
 * BullMQ workers. Processors run in the API process; for higher throughput,
 * scale these out as separate Compose worker services when required.
 *
 * SignaturesModule is imported for the reminder sweep the signing processor
 * runs on a schedule — it does not import this module, so there is no cycle.
 */
@Module({
  imports: [MailerModule, SignaturesModule],
  providers: [
    NotificationProcessor,
    SigningProcessor,
    ReminderSchedulerService,
    QueueMetricsService,
  ],
})
export class JobsModule {}
