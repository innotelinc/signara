import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { WebhooksService } from '../webhooks/webhooks.service';

interface DeliverWebhookJob {
  deliveryId: string;
}

/** Repeatable job name for the endpoint health sweep (see the scheduler). */
export const SWEEP_WEBHOOKS_JOB = 'sweep-endpoints';

/**
 * Two job kinds share the `webhooks` queue: one job per delivery attempt, and
 * the repeatable health sweep. The queue carries the default retry policy
 * (5 attempts, exponential backoff), and WebhooksService.deliver records the
 * outcome before rethrowing so the delivery log is accurate at every attempt.
 */
@Processor('webhooks')
export class WebhookProcessor extends WorkerHost {
  private readonly logger = new Logger('WebhookProcessor');

  constructor(private readonly webhooks: WebhooksService) {
    super();
  }

  async process(job: Job<DeliverWebhookJob>): Promise<void> {
    // The sweep disables endpoints that have failed for weeks (issue #85). It
    // is a job rather than a timer so it survives restarts and cannot
    // double-fire across API replicas, exactly like the reminder sweep.
    if (job.name === SWEEP_WEBHOOKS_JOB) {
      const result = await this.webhooks.sweepUnhealthyEndpoints();
      if (result.disabled.length > 0) {
        this.logger.warn(
          `webhook health sweep disabled ${result.disabled.length} of ${result.scanned} active endpoint(s)`,
        );
      }
      return;
    }

    const { deliveryId } = job.data;
    try {
      await this.webhooks.deliver(deliveryId);
    } catch (err) {
      this.logger.warn(
        `Delivery ${deliveryId} attempt ${job.attemptsMade + 1} failed: ${(err as Error).message}`,
      );
      throw err; // BullMQ retries per defaultJobOptions
    }
  }
}
