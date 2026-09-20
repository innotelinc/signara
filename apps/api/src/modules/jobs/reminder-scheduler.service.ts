import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Queue } from 'bullmq';
import { SWEEP_REMINDERS_JOB } from './signing.processor';

/**
 * Puts the automatic-reminder sweep on a schedule (issue #82).
 *
 * The queue does the scheduling rather than a cron entry or an in-process
 * timer: a repeatable job survives restarts, lives in Redis so it cannot
 * double-fire when more than one API replica is running, and shows up in the
 * existing `bullmq_*` metrics. The trade-off is that a stopped API reminds
 * nobody, which is why the queue's waiting and failed counts are alerted on.
 */
@Injectable()
export class ReminderSchedulerService implements OnModuleInit {
  private readonly logger = new Logger('ReminderScheduler');

  constructor(
    @InjectQueue('signing') private readonly signingQueue: Queue,
    private readonly config: ConfigService,
  ) {}

  async onModuleInit(): Promise<void> {
    const everyMinutes = this.config.get<number>('reminders.sweepIntervalMinutes') ?? 360;

    if (!Number.isFinite(everyMinutes) || everyMinutes <= 0) {
      this.logger.log(
        'automatic signing reminders are disabled (REMINDER_SWEEP_INTERVAL_MINUTES <= 0)',
      );
      return;
    }

    try {
      // Adding the same repeat configuration again is idempotent — BullMQ keys
      // repeatable jobs by name and interval, so restarts do not stack sweeps.
      await this.signingQueue.add(
        SWEEP_REMINDERS_JOB,
        {},
        { repeat: { every: everyMinutes * 60_000 }, removeOnComplete: true, removeOnFail: 50 },
      );
      this.logger.log(`automatic signing reminders sweep every ${everyMinutes} minute(s)`);
    } catch (error) {
      // A scheduling failure must not stop the API from serving: the request
      // paths work without it.
      this.logger.error(
        `could not schedule the reminder sweep: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
}
