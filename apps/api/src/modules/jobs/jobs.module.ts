import { Module } from '@nestjs/common';
import { NotificationProcessor } from './notification.processor';
import { SigningProcessor } from './signing.processor';
import { MailerModule } from '../mailer/mailer.module';

/**
 * BullMQ workers. Processors run in the API process; for higher throughput
 * scale these out as separate deployments (see infra/kubernetes).
 */
@Module({
  imports: [MailerModule],
  providers: [NotificationProcessor, SigningProcessor],
})
export class JobsModule {}