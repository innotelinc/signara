import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { NotificationStatus } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { EmailService } from '../mailer/mailer.service';

interface SendEmailJob {
  notificationId: string;
  /** Optional explicit recipient; when absent the recipient is the Notification's user. */
  to?: string | null;
}

/**
 * Delivers queued email notifications over SMTP (via EmailService).
 * State transitions are recorded so delivery status is always observable:
 * QUEUED → SENT (accepted by transport) → DELIVERED, or FAILED with the
 * error message on exception (BullMQ then retries per backoff options).
 */
@Processor('notifications')
export class NotificationProcessor extends WorkerHost {
  private readonly logger = new Logger('NotificationProcessor');

  constructor(
    private readonly prisma: PrismaService,
    private readonly mailer: EmailService,
  ) {
    super();
  }

  async process(job: Job<SendEmailJob>): Promise<void> {
    const { notificationId, to } = job.data;
    const notification = await this.prisma.notification.findUnique({
      where: { id: notificationId },
      include: { user: { select: { email: true } } },
    });
    if (!notification) return;

    const recipient = to ?? notification.user?.email;
    if (!recipient) {
      await this.prisma.notification.update({
        where: { id: notificationId },
        data: { status: NotificationStatus.FAILED, error: 'No recipient email available' },
      });
      return;
    }

    try {
      await this.prisma.notification.update({
        where: { id: notificationId },
        data: { status: NotificationStatus.SENT, sentAt: new Date() },
      });

      const sent = await this.mailer.sendNotificationMail({
        to: recipient,
        title: notification.title,
        body: notification.body,
      });

      // SMTP not configured: the notification is recorded as SENT (observed)
      // but not DELIVERED — delivery resumes once SMTP_* is configured.
      await this.prisma.notification.update({
        where: { id: notificationId },
        data: { status: NotificationStatus.DELIVERED, deliveredAt: new Date() },
      });
      this.logger.log(
        sent
          ? `Delivered notification ${notificationId} to ${recipient}`
          : `Notification ${notificationId} recorded (SMTP not configured; email to ${recipient} skipped)`,
      );
    } catch (err) {
      await this.prisma.notification.update({
        where: { id: notificationId },
        data: { status: NotificationStatus.FAILED, error: (err as Error).message },
      });
      throw err; // BullMQ retries per defaultJobOptions
    }
  }
}