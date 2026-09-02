import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { BullModule } from '@nestjs/bullmq';

/**
 * Redis-backed background job queues (BullMQ). See docs/Architecture.md § Jobs.
 *  - notifications : email/SMS dispatch
 *  - signing      : reminders, escalation, expiry sweeps
 *  - audit        : async audit export rendering
 */
@Global()
@Module({
  imports: [
    BullModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        connection: {
          url: config.get<string>('redis.url') ?? 'redis://localhost:6379',
          maxRetriesPerRequest: null,
        },
        defaultJobOptions: {
          attempts: 5,
          backoff: { type: 'exponential', delay: 2_000 },
          removeOnComplete: 500,
          removeOnFail: 2_000,
        },
      }),
    }),
    BullModule.registerQueue(
      { name: 'notifications' },
      { name: 'signing' },
      { name: 'audit' },
    ),
  ],
  exports: [BullModule],
})
export class QueueModule {}