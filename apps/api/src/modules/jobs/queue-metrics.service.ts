import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Queue } from 'bullmq';
import { bullmqQueueFailed, bullmqQueueWaiting } from '../../common/metrics';

@Injectable()
export class QueueMetricsService implements OnModuleInit, OnModuleDestroy {
  private timer?: NodeJS.Timeout;

  constructor(
    @InjectQueue('notifications') private readonly notifications: Queue,
    @InjectQueue('signing') private readonly signing: Queue,
    @InjectQueue('audit') private readonly audit: Queue,
  ) {}

  onModuleInit(): void {
    void this.refresh();
    this.timer = setInterval(() => void this.refresh(), 30_000);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  private async refresh(): Promise<void> {
    await Promise.all(
      [
        ['notifications', this.notifications],
        ['signing', this.signing],
        ['audit', this.audit],
      ].map(async ([name, queue]) => {
        try {
          const counts = await (queue as Queue).getJobCounts('waiting', 'failed');
          bullmqQueueWaiting.set({ queue: name as string }, counts.waiting ?? 0);
          bullmqQueueFailed.set({ queue: name as string }, counts.failed ?? 0);
        } catch {
          // Redis outages are surfaced by the API readiness/queue alerts.
        }
      }),
    );
  }
}
