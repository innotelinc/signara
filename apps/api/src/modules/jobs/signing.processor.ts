import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { PrismaService } from '../../prisma/prisma.service';
import { EmailService } from '../mailer/mailer.service';
import { SignaturesService } from '../signatures/signatures.service';

/** Repeatable job that finds requests due for an automatic reminder (#82). */
export const SWEEP_REMINDERS_JOB = 'sweep-reminders';

interface SigningJob {
  requestId?: string;
  signerId?: string;
  attempt?: number;
  kind?: 'invite' | 'reminder';
}

/**
 * Sends signing invitations and reminders over SMTP (via EmailService), and runs
 * the scheduled work that decides who should be reminded.
 * Signing links are `{WEB_URL}/sign/{signer.token}` — the token is the
 * credential, so emails must be transport-secured (SMTP TLS). See
 * docs/Security.md § Signing links.
 */
@Processor('signing')
export class SigningProcessor extends WorkerHost {
  private readonly logger = new Logger('SigningProcessor');

  constructor(
    private readonly prisma: PrismaService,
    private readonly mailer: EmailService,
    private readonly signatures: SignaturesService,
  ) {
    super();
  }

  async process(job: Job<SigningJob>): Promise<void> {
    if (job.name === SWEEP_REMINDERS_JOB) {
      const swept = await this.signatures.sweepDueReminders();
      this.logger.log(
        `reminder sweep: ${swept.requests} request(s) due, ${swept.enqueued} reminder(s) queued`,
      );
      return;
    }

    const { requestId, signerId } = job.data;
    if (!requestId || !signerId) {
      this.logger.warn(`job ${job.name} (${job.id}) is missing requestId/signerId; skipping`);
      return;
    }

    // The job name is the reliable signal here, with data.kind as an override.
    // Trusting data.kind alone sent reminders using the invitation text, because
    // remind() enqueued them without setting it.
    const kind: 'invite' | 'reminder' =
      job.data.kind ?? (job.name === 'send-signing-reminder' ? 'reminder' : 'invite');

    const signer = await this.prisma.signer.findUnique({
      where: { id: signerId },
      include: { request: { include: { document: true } } },
    });
    if (!signer) {
      this.logger.warn(`Signer ${signerId} not found; skipping job`);
      return;
    }
    if (
      signer.status === 'SIGNED' ||
      signer.status === 'DECLINED' ||
      signer.request.status === 'CANCELLED'
    ) {
      return;
    }

    const webUrl = process.env.WEB_URL ?? 'https://app.signara.innotel.us';
    const documentTitle = signer.request.title ?? signer.request.document.title;

    const signUrl = `${webUrl.replace(/\/$/, '')}/sign/${signer.token}`;
    const sent = await this.mailer.sendSigningMail({
      kind,
      signerName: signer.name,
      signerEmail: signer.email,
      documentTitle,
      requestTitle: signer.request.title,
      deadline: signer.request.deadline,
      message: signer.request.message,
      signUrl,
    });

    if (sent) {
      this.logger.log(`[${kind}] emailed ${signer.email} for request ${requestId}`);
    } else {
      this.logger.debug(`[${kind}] SMTP not configured — would email ${signer.email} (${signUrl})`);
    }
  }
}
