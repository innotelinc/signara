import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { WebhooksService } from '../webhooks/webhooks.service';

interface DeliverWebhookJob {
  deliveryId: string;
}

/**
 * One job per delivery attempt. The queue carries the default retry policy
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
