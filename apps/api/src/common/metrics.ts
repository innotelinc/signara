import { collectDefaultMetrics, Counter, Gauge, Histogram, register } from 'prom-client';

collectDefaultMetrics();

export const httpRequestsTotal =
  (register.getSingleMetric('signara_http_requests_total') as Counter<string> | undefined) ??
  new Counter({
    name: 'signara_http_requests_total',
    help: 'Total HTTP requests handled by the Signara API',
    labelNames: ['method', 'route', 'status'],
  });

export const httpRequestDurationSeconds =
  (register.getSingleMetric('signara_http_request_duration_seconds') as
    Histogram<string> | undefined) ??
  new Histogram({
    name: 'signara_http_request_duration_seconds',
    help: 'HTTP request duration in seconds',
    labelNames: ['method', 'route'],
    buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  });

export const bullmqQueueWaiting =
  (register.getSingleMetric('bullmq_queue_waiting_count') as Gauge<string> | undefined) ??
  new Gauge({
    name: 'bullmq_queue_waiting_count',
    help: 'Number of waiting BullMQ jobs by queue',
    labelNames: ['queue'],
  });

export const certificateExpiryTimestamp =
  (register.getSingleMetric('signara_certificate_expiry_timestamp_seconds') as
    Gauge<string> | undefined) ??
  new Gauge({
    name: 'signara_certificate_expiry_timestamp_seconds',
    help: 'Unix timestamp at which an active signing certificate expires',
    labelNames: ['certificate', 'organization'],
  });

export const bullmqQueueFailed =
  (register.getSingleMetric('bullmq_queue_failed_count') as Gauge<string> | undefined) ??
  new Gauge({
    name: 'bullmq_queue_failed_count',
    help: 'Number of failed BullMQ jobs by queue',
    labelNames: ['queue'],
  });

/**
 * Documents Meilisearch refused to index or remove. Document writes must not
 * fail because search is unavailable, so these are caught and logged — which is
 * exactly how a *permanent* indexing failure stays invisible: the deployment
 * looked healthy while the index held nothing and every search returned no
 * results. Exported as a counter so that is a page, not a log line.
 */
export const searchIndexFailuresTotal =
  (register.getSingleMetric('signara_search_index_failures_total') as Counter<string> | undefined) ??
  new Counter({
    name: 'signara_search_index_failures_total',
    help: 'Document index operations (index/delete) Meilisearch rejected',
    labelNames: ['operation'],
  });
