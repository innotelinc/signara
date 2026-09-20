import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { createHmac, randomBytes } from 'node:crypto';
import { Prisma, WebhookDeliveryStatus } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { AuthenticatedUser } from '../../common/types';

/** Event names a tenant can subscribe to. `*` subscribes to all of them. */
export const WEBHOOK_EVENTS = [
  'request.created',
  'request.sent',
  'request.viewed',
  'request.signed',
  'request.completed',
  'request.declined',
  'request.cancelled',
  'request.expired',
  'request.reminded',
  'ping',
] as const;

export type WebhookEvent = (typeof WEBHOOK_EVENTS)[number];

interface EmitInput {
  organizationId: string;
  /** Included in the payload so a subscriber can correlate without a second call. */
  requestId?: string;
  payload?: Record<string, unknown>;
}

/**
 * Builds the `X-Signara-Signature` header value. The signed string is
 * `<unix-timestamp>.<raw-body>` — the timestamp is inside the signature so a
 * captured delivery cannot be replayed without also moving the clock back,
 * and receivers are expected to reject old timestamps. Exported so the docs,
 * tests, and any receiver implementation share one definition.
 */
export function signWebhookPayload(secret: string, timestamp: number, body: string): string {
  const digest = createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
  return `t=${timestamp},v1=${digest}`;
}

/**
 * Rejects URLs that would make a tenant-supplied webhook reachable into the
 * deployment's own network. Without this, registering
 * `http://signara-redis:6379/` or `http://signara-postgres:5432/` would turn the
 * API into an SSRF proxy that could also *read the response body* through the
 * delivery log — a real pivot, not a theoretical one, since the API shares a
 * Docker network with Redis, Postgres and MinIO.
 */
export function isPrivateHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');

  // IPv6 literal (URL.hostname keeps the brackets off).
  if (host.includes(':')) {
    return host === '::1' || host === '::' || /^(fc|fd|fe80)/.test(host);
  }

  // A name with no dot is single-label: `localhost`, or a Compose service name
  // such as `signara-redis`. Those only resolve inside this deployment's own
  // DNS, so treating them as internal is what actually closes the pivot above.
  if (!host.includes('.') || /\.(local|localhost|internal)$/.test(host)) return true;

  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return false;
  const a = Number(m[1]);
  const b = Number(m[2]);
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168)
  );
}

@Injectable()
export class WebhooksService {
  private readonly logger = new Logger('WebhooksService');

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    @InjectQueue('webhooks') private readonly queue: Queue,
  ) {}

  private assertDeliverableUrl(raw: string): URL {
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      throw new BadRequestException('url must be an absolute http(s) URL');
    }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') {
      throw new BadRequestException('url must be an absolute http(s) URL');
    }

    const allowPrivate = this.config.get<boolean>('webhooks.allowPrivate') ?? false;
    if (isPrivateHost(url.hostname)) {
      if (!allowPrivate) {
        throw new BadRequestException(
          `url resolves to a private or loopback host (${url.hostname}); set WEBHOOKS_ALLOW_PRIVATE=true to allow internal endpoints`,
        );
      }
      // Explicitly opted in to internal endpoints, so plain http is meaningful
      // there (a sidecar on the Docker network will not have a certificate).
      return url;
    }
    if (url.protocol !== 'https:') {
      throw new BadRequestException('url must use https for non-private hosts');
    }
    return url;
  }

  private resolveEvents(events?: string[]): string[] {
    if (!events || events.length === 0) return ['*'];
    const unknown = events.filter((e) => !(WEBHOOK_EVENTS as readonly string[]).includes(e));
    if (unknown.length > 0) {
      throw new BadRequestException(`unknown event(s): ${unknown.join(', ')}`);
    }
    return [...new Set(events)];
  }

  /**
   * Registers an endpoint. The signing secret is returned exactly once, like an
   * API key — but unlike a key it has to stay recoverable on our side, because
   * every delivery is signed with it at send time.
   */
  async create(
    user: AuthenticatedUser,
    data: { url: string; events?: string[]; description?: string },
  ) {
    const orgId = user.org?.id;
    if (!orgId) throw new ForbiddenException('No active tenant');

    const url = this.assertDeliverableUrl(data.url);
    const secret = `whsec_${randomBytes(32).toString('base64url')}`;

    const endpoint = await this.prisma.webhookEndpoint.create({
      data: {
        organizationId: orgId,
        url: url.toString(),
        events: this.resolveEvents(data.events),
        description: data.description,
        secret,
      },
    });

    return {
      id: endpoint.id,
      url: endpoint.url,
      events: endpoint.events,
      description: endpoint.description,
      active: endpoint.active,
      createdAt: endpoint.createdAt,
      secret,
    };
  }

  async list(user: AuthenticatedUser) {
    const orgId = user.org?.id;
    if (!orgId) throw new ForbiddenException('No active tenant');
    return this.prisma.webhookEndpoint.findMany({
      where: { organizationId: orgId },
      select: {
        id: true,
        url: true,
        events: true,
        description: true,
        active: true,
        disabledAt: true,
        createdAt: true,
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  async remove(user: AuthenticatedUser, id: string) {
    const orgId = user.org?.id;
    if (!orgId) throw new ForbiddenException('No active tenant');
    const endpoint = await this.prisma.webhookEndpoint.findFirst({
      where: { id, organizationId: orgId },
    });
    if (!endpoint) throw new NotFoundException('Webhook endpoint not found');
    // Deliveries cascade with the endpoint, so an endpoint's history goes with it.
    await this.prisma.webhookEndpoint.delete({ where: { id } });
    return { success: true };
  }

  /** Recent delivery attempts, so "we never received it" is answerable from data. */
  async listDeliveries(user: AuthenticatedUser, endpointId?: string) {
    const orgId = user.org?.id;
    if (!orgId) throw new ForbiddenException('No active tenant');
    return this.prisma.webhookDelivery.findMany({
      where: { organizationId: orgId, ...(endpointId ? { endpointId } : {}) },
      select: {
        id: true,
        endpointId: true,
        event: true,
        status: true,
        attempts: true,
        responseStatus: true,
        error: true,
        createdAt: true,
        lastAttemptAt: true,
        deliveredAt: true,
      },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
  }

  /** Sends a `ping` to one endpoint, so an operator can prove a URL works. */
  async ping(user: AuthenticatedUser, id: string) {
    const orgId = user.org?.id;
    if (!orgId) throw new ForbiddenException('No active tenant');
    const endpoint = await this.prisma.webhookEndpoint.findFirst({
      where: { id, organizationId: orgId },
    });
    if (!endpoint) throw new NotFoundException('Webhook endpoint not found');

    const delivery = await this.enqueue(endpoint, 'ping', {
      event: 'ping',
      organizationId: orgId,
      createdAt: new Date().toISOString(),
    });
    return { deliveryId: delivery.id, endpointId: endpoint.id, event: 'ping' };
  }

  /**
   * Fans an event out to every active endpoint subscribed to it. Called from
   * inside the signing flow, so it must never be the reason a signature fails —
   * callers wrap it, and a queue/DB error here is logged, not thrown.
   */
  async emit(event: WebhookEvent, input: EmitInput): Promise<number> {
    const endpoints = await this.prisma.webhookEndpoint.findMany({
      where: {
        organizationId: input.organizationId,
        active: true,
        OR: [{ events: { has: event } }, { events: { has: '*' } }],
      },
    });
    if (endpoints.length === 0) return 0;

    const payload = {
      event,
      organizationId: input.organizationId,
      ...(input.requestId ? { requestId: input.requestId } : {}),
      createdAt: new Date().toISOString(),
      ...(input.payload ?? {}),
    } as Prisma.InputJsonValue;

    for (const endpoint of endpoints) {
      await this.enqueue(endpoint, event, payload);
    }
    return endpoints.length;
  }

  private async enqueue(
    endpoint: { id: string; organizationId: string },
    event: string,
    payload: Prisma.InputJsonValue,
  ) {
    const delivery = await this.prisma.webhookDelivery.create({
      data: {
        endpointId: endpoint.id,
        organizationId: endpoint.organizationId,
        event,
        payload,
      },
    });
    await this.queue.add(
      'deliver',
      { deliveryId: delivery.id },
      // A stable id keeps a duplicate emit from double-delivering the same row.
      { jobId: `delivery-${delivery.id}` },
    );
    return delivery;
  }

  /**
   * Performs one delivery attempt. Throws on a non-2xx response or a transport
   * error so BullMQ applies its retry/backoff policy; the delivery row always
   * records what happened first.
   */
  async deliver(deliveryId: string): Promise<void> {
    const delivery = await this.prisma.webhookDelivery.findUnique({
      where: { id: deliveryId },
      include: { endpoint: { select: { url: true, secret: true, active: true } } },
    });
    // The endpoint (and its deliveries) were deleted while queued.
    if (!delivery) return;

    const attempts = delivery.attempts + 1;

    if (!delivery.endpoint.active) {
      await this.prisma.webhookDelivery.update({
        where: { id: delivery.id },
        data: {
          status: WebhookDeliveryStatus.FAILED,
          attempts,
          error: 'endpoint disabled',
          lastAttemptAt: new Date(),
        },
      });
      return; // Not retryable — retrying a disabled endpoint is just noise.
    }

    const body = JSON.stringify(delivery.payload);
    const timestamp = Math.floor(Date.now() / 1000);
    const signature = signWebhookPayload(delivery.endpoint.secret, timestamp, body);
    const timeoutMs = this.config.get<number>('webhooks.timeoutMs') ?? 10_000;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(delivery.endpoint.url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'user-agent': 'Signara-Webhooks/1.0',
          'x-signara-event': delivery.event,
          'x-signara-delivery': delivery.id,
          'x-signara-signature': signature,
        },
        body,
        signal: controller.signal,
        // A redirect would let a validated public URL hand us off to a private
        // one, defeating the check made when the endpoint was registered.
        redirect: 'error',
      });

      if (response.ok) {
        await this.prisma.webhookDelivery.update({
          where: { id: delivery.id },
          data: {
            status: WebhookDeliveryStatus.DELIVERED,
            attempts,
            responseStatus: response.status,
            error: null,
            lastAttemptAt: new Date(),
            deliveredAt: new Date(),
          },
        });
        this.logger.log(
          `Delivered ${delivery.event} to ${delivery.endpoint.url} (${response.status})`,
        );
        return;
      }

      await this.prisma.webhookDelivery.update({
        where: { id: delivery.id },
        data: {
          status: WebhookDeliveryStatus.FAILED,
          attempts,
          responseStatus: response.status,
          error: `HTTP ${response.status}`,
          lastAttemptAt: new Date(),
        },
      });
      throw new Error(`Webhook endpoint returned HTTP ${response.status}`);
    } catch (err) {
      const message = (err as Error).message;
      // Only write the failure again if the response-phase update above did not
      // already record it (a transport error has no status to report).
      if (message.startsWith('Webhook endpoint returned HTTP')) throw err;
      await this.prisma.webhookDelivery.update({
        where: { id: delivery.id },
        data: {
          status: WebhookDeliveryStatus.FAILED,
          attempts,
          error: message,
          lastAttemptAt: new Date(),
        },
      });
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }
}
