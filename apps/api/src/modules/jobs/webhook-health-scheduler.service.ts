import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Queue } from 'bullmq';
import { SWEEP_WEBHOOKS_JOB } from './webhook.processor';

/**
 * Puts the webhook endpoint health sweep on a schedule (issue #85).
 *
 * Same shape as the reminder sweep on the signing queue: a repeatable job, so
 * it lives in Redis, survives restarts, and cannot double-fire when more than
 * one API replica is running. The sweep disables endpoints that have not
 * delivered successfully for weeks; a stopped API sweeps nothing, which is the
 * honest trade-off (a disabled endpoint is a convenience, not a correctness
 * property — delivery correctness does not depend on the sweep running).
 */
@Injectable()
export class WebhookHealthSchedulerService implements OnModuleInit {
  private readonly logger = new Logger('WebhookHealthScheduler');

  constructor(
    @InjectQueue('webhooks') private readonly webhooksQueue: Queue,
    private readonly config: ConfigService,
  ) {}

  async onModuleInit(): Promise<void> {
    const everyMinutes = this.config.get<number>('webhooks.healthSweepIntervalMinutes') ?? 360;

    if (!Number.isFinite(everyMinutes) || everyMinutes <= 0) {
      this.logger.log(
        'webhook endpoint health sweep is disabled (WEBHOOKS_AUTODISABLE_SWEEP_INTERVAL_MINUTES <= 0)',
      );
      return;
    }

    try {
      // Idempotent: BullMQ keys repeatable jobs by name and interval, so a
      // restart replaces the schedule rather than stacking a second sweep.
      await this.webhooksQueue.add(
        SWEEP_WEBHOOKS_JOB,
        {},
        { repeat: { every: everyMinutes * 60_000 }, removeOnComplete: true, removeOnFail: 50 },
      );
      this.logger.log(`webhook endpoint health sweep every ${everyMinutes} minute(s)`);
    } catch (error) {
      // A scheduling failure must not stop the API: delivery does not depend on it.
      this.logger.error(
        `could not schedule the webhook health sweep: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
}
