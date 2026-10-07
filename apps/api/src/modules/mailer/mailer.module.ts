import { Module } from '@nestjs/common';
import { EmailService } from './mailer.service';
import { BrandingModule } from '../branding/branding.module';

/**
 * SMTP delivery for all outbound email (signing invites/reminders and
 * notification emails). Configure via SMTP_* env vars (see configuration.ts).
 * When SMTP is not configured, EmailService degrades to a descriptive log and
 * returns false so workers stay observable without failing the job.
 *
 * BrandingModule is imported so a signing mail renders under the tenant's
 * identity when it has one (issue #87).
 */
@Module({
  imports: [BrandingModule],
  providers: [EmailService],
  exports: [EmailService],
})
export class MailerModule {}
