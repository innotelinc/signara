import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { PrismaService } from '../../prisma/prisma.service';
import { EmailService } from '../mailer/mailer.service';

interface SigningJob {
  requestId: string;
  signerId: string;
  attempt?: number;
  kind?: 'invite' | 'reminder';
}

/**
 * Sends signing invitations and reminders over SMTP (via EmailService).
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
  ) {
    super();
  }

  async process(job: Job<SigningJob>): Promise<void> {
    const { requestId, signerId, kind } = job.data;
    const signer = await this.prisma.signer.findUnique({
      where: { id: signerId },
      include: { request: { include: { document: true } } },
    });
    if (!signer) {
      this.logger.warn(`Signer ${signerId} not found; skipping job`);
      return;
    }
    if (signer.status === 'SIGNED' || signer.status === 'DECLINED' || signer.request.status === 'CANCELLED') {
      return;
    }

    const webUrl = process.env.WEB_URL ?? 'https://app.signara.innotel.us';
    const kindLabel = kind === 'reminder' ? 'reminder' : 'invite';
    const documentTitle = signer.request.title ?? signer.request.document.title;

    const signUrl = `${webUrl.replace(/\/$/, '')}/sign/${signer.token}`;
    const sent = await this.mailer.sendSigningMail({
      kind: kind === 'reminder' ? 'reminder' : 'invite',
      signerName: signer.name,
      signerEmail: signer.email,
      documentTitle,
      requestTitle: signer.request.title,
      deadline: signer.request.deadline,
      message: signer.request.message,
      signUrl,
    });

    if (sent) {
      this.logger.log(`[${kindLabel}] emailed ${signer.email} for request ${requestId}`);
    } else {
      this.logger.debug(`[${kindLabel}] SMTP not configured — would email ${signer.email} (${signUrl})`);
    }
  }
}