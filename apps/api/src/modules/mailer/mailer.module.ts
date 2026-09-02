import { Module } from '@nestjs/common';
import { EmailService } from './mailer.service';

/**
 * SMTP delivery for all outbound email (signing invites/reminders and
 * notification emails). Configure via SMTP_* env vars (see configuration.ts).
 * When SMTP is not configured, EmailService degrades to a descriptive log and
 * returns false so workers stay observable without failing the job.
 */
@Module({
  providers: [EmailService],
  exports: [EmailService],
})
export class MailerModule {}