import { ForbiddenException, Injectable } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { NotificationChannel } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { AuthenticatedUser } from '../../common/types';

@Injectable()
export class NotificationsService {
  constructor(
    private readonly prisma: PrismaService,
    @InjectQueue('notifications') private readonly notificationsQueue: Queue,
  ) {}

  async list(user: AuthenticatedUser, query: { unreadOnly?: boolean; limit?: number; offset?: number }) {
    const where = {
      userId: user.id,
      ...(query.unreadOnly ? { readAt: null } : {}),
    };
    const [total, unread, items] = await this.prisma.$transaction([
      this.prisma.notification.count({ where }),
      this.prisma.notification.count({ where: { userId: user.id, readAt: null } }),
      this.prisma.notification.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: query.offset ?? 0,
        take: Math.min(query.limit ?? 25, 100),
      }),
    ]);
    return { total, unread, items };
  }

  async markRead(user: AuthenticatedUser, id: string) {
    const notification = await this.prisma.notification.findFirst({ where: { id, userId: user.id } });
    if (!notification) throw new ForbiddenException('Notification not found');
    return this.prisma.notification.update({ where: { id }, data: { readAt: new Date() } });
  }

  async markAllRead(user: AuthenticatedUser) {
    await this.prisma.notification.updateMany({ where: { userId: user.id, readAt: null }, data: { readAt: new Date() } });
    return { success: true };
  }

  /**
   * Creates the notification row and enqueues channel delivery.
   * Email/SMS workers (see modules/jobs) send via SMTP provider.
   */
  async create(input: {
    userId: string;
    organizationId?: string | null;
    type: string;
    title: string;
    body?: string;
    channel?: NotificationChannel;
    metadata?: Record<string, unknown>;
    sendEmail?: boolean;
  }): Promise<void> {
    const notification = await this.prisma.notification.create({
      data: {
        userId: input.userId,
        organizationId: input.organizationId ?? null,
        type: input.type,
        channel: input.channel ?? NotificationChannel.IN_APP,
        title: input.title,
        body: input.body,
        metadata: input.metadata as object | undefined,
      },
    });

    if (input.sendEmail) {
      await this.notificationsQueue.add(
        'send-email',
        { notificationId: notification.id, to: null }, // email address resolved by the worker
        { attempts: 5, backoff: { type: 'exponential', delay: 30_000 } },
      );
    }
  }
}