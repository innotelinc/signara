import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { createHmac } from 'node:crypto';
import { BadRequestException } from '@nestjs/common';
import { WebhookDeliveryStatus } from '@prisma/client';
import { isPrivateHost, signWebhookPayload, WebhooksService } from './webhooks.service';
import { PrismaService } from '../../prisma/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';
import { AuthenticatedUser } from '../../common/types';

describe('WebhooksService', () => {
  let service: WebhooksService;

  const prismaMock = {
    webhookEndpoint: {
      create: jest.fn(),
      findMany: jest.fn().mockResolvedValue([]),
      findFirst: jest.fn(),
      update: jest.fn().mockResolvedValue({}),
      delete: jest.fn(),
    },
    webhookDelivery: {
      create: jest.fn(),
      findUnique: jest.fn(),
      findFirst: jest.fn(),
      findMany: jest.fn(),
      count: jest.fn().mockResolvedValue(0),
      update: jest.fn().mockResolvedValue({}),
    },
    membership: {
      findMany: jest.fn().mockResolvedValue([]),
    },
  };

  const notificationsMock = {
    create: jest.fn().mockResolvedValue(undefined),
  } as unknown as NotificationsService;

  const queueMock = { add: jest.fn().mockResolvedValue(undefined) };
  let configValues: Record<string, unknown> = {};
  const configMock = {
    get: jest.fn((key: string) => configValues[key]),
  } as unknown as ConfigService;

  const user = {
    id: 'u-1',
    email: 'owner@signara.local',
    displayName: 'Owner',
    platformRole: 'USER' as const,
    sub: 'sub-1',
    groups: [],
    org: { id: 'org-1', slug: 'acme', role: 'OWNER', permissions: [] },
  } as AuthenticatedUser;

  beforeEach(async () => {
    jest.clearAllMocks();
    configValues = {
      'webhooks.allowPrivate': false,
      'webhooks.timeoutMs': 10_000,
      'webhooks.autoDisableAfterDays': 14,
      'webhooks.autoDisableMinFailures': 5,
    };
    const moduleRef = await Test.createTestingModule({
      providers: [
        WebhooksService,
        { provide: PrismaService, useValue: prismaMock },
        { provide: ConfigService, useValue: configMock },
        { provide: NotificationsService, useValue: notificationsMock },
        { provide: 'BullQueue_webhooks', useValue: queueMock },
      ],
    }).compile();
    service = moduleRef.get(WebhooksService);
  });

  describe('signWebhookPayload', () => {
    it('produces the exact digest a receiver can recompute', () => {
      const secret = 'whsec_test';
      const timestamp = 1_700_000_000;
      const body = '{"event":"request.signed","requestId":"req-1"}';

      // Recomputed here the way the documentation tells a subscriber to.
      const expected = createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');

      expect(signWebhookPayload(secret, timestamp, body)).toBe(`t=${timestamp},v1=${expected}`);
    });

    it('covers the timestamp, so a captured delivery cannot be replayed later', () => {
      const body = '{"event":"ping"}';
      const first = signWebhookPayload('whsec_test', 1_700_000_000, body);
      const second = signWebhookPayload('whsec_test', 1_700_000_001, body);
      expect(first).not.toBe(second);
    });
  });

  describe('isPrivateHost', () => {
    it.each([
      'localhost',
      'signara-redis',
      'subscriber',
      'redis.internal',
      'db.local',
      '127.0.0.1',
      '10.1.2.3',
      '172.16.0.1',
      '172.31.255.254',
      '192.168.1.46',
      '169.254.169.254',
      '100.64.0.1',
      '::1',
      'fd00::1',
      'fe80::1',
    ])('treats %s as private', (host) => {
      expect(isPrivateHost(host)).toBe(true);
    });

    it.each(['api.example.com', '8.8.8.8', '172.32.0.1', 'hooks.signara.io', '2606:4700::1'])(
      'treats %s as public',
      (host) => {
        expect(isPrivateHost(host)).toBe(false);
      },
    );
  });

  describe('create', () => {
    const stored = {
      id: 'wh-1',
      url: 'https://hooks.example.com/signara',
      events: ['*'],
      description: null,
      active: true,
      createdAt: new Date('2026-09-20T00:00:00Z'),
    };

    it('rejects a private endpoint by default — the API shares a network with Redis and Postgres', async () => {
      await expect(service.create(user, { url: 'http://signara-redis:6379/' })).rejects.toThrow(
        BadRequestException,
      );
      await expect(service.create(user, { url: 'https://10.0.0.5/hook' })).rejects.toThrow(
        /private or loopback/,
      );
      expect(prismaMock.webhookEndpoint.create).not.toHaveBeenCalled();
    });

    it('allows a private endpoint once the deployment opts in', async () => {
      configValues['webhooks.allowPrivate'] = true;
      prismaMock.webhookEndpoint.create.mockResolvedValue(stored);

      await service.create(user, { url: 'http://subscriber:8080/hook' });

      expect(prismaMock.webhookEndpoint.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ url: 'http://subscriber:8080/hook' }),
        }),
      );
    });

    it('requires https for a public host', async () => {
      await expect(service.create(user, { url: 'http://hooks.example.com/x' })).rejects.toThrow(
        /must use https/,
      );
    });

    it('rejects a non-http scheme', async () => {
      await expect(service.create(user, { url: 'ftp://hooks.example.com/x' })).rejects.toThrow(
        /absolute http\(s\) URL/,
      );
    });

    it('rejects an unknown event name', async () => {
      await expect(
        service.create(user, {
          url: 'https://hooks.example.com/x',
          events: ['request.signed', 'nope'],
        }),
      ).rejects.toThrow(/unknown event\(s\): nope/);
    });

    it('subscribes to everything when no events are given, and returns the secret once', async () => {
      prismaMock.webhookEndpoint.create.mockResolvedValue(stored);

      const created = await service.create(user, { url: 'https://hooks.example.com/signara' });

      expect(prismaMock.webhookEndpoint.create).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ events: ['*'] }) }),
      );
      expect(created.secret).toMatch(/^whsec_[A-Za-z0-9_-]{43}$/);
      // The secret is stored (it signs every delivery) but must never be
      // returned by a read route — only by the create response above.
      await service.list(user);
      const listArgs = prismaMock.webhookEndpoint.findMany.mock.calls[0][0];
      expect(listArgs.select).not.toHaveProperty('secret');
    });
  });

  describe('emit', () => {
    it('selects only active endpoints subscribed to the event', async () => {
      prismaMock.webhookEndpoint.findMany.mockResolvedValue([
        { id: 'wh-1', organizationId: 'org-1' },
        { id: 'wh-2', organizationId: 'org-1' },
      ]);
      prismaMock.webhookDelivery.create
        .mockResolvedValueOnce({ id: 'wd-1' })
        .mockResolvedValueOnce({ id: 'wd-2' });

      const count = await service.emit('request.signed', {
        organizationId: 'org-1',
        requestId: 'req-1',
        payload: { signerId: 's-1' },
      });

      expect(count).toBe(2);
      expect(prismaMock.webhookEndpoint.findMany).toHaveBeenCalledWith({
        where: {
          organizationId: 'org-1',
          active: true,
          OR: [{ events: { has: 'request.signed' } }, { events: { has: '*' } }],
        },
      });
      // One job per delivery, with a stable id so a duplicate emit cannot
      // double-deliver the same row.
      expect(queueMock.add).toHaveBeenNthCalledWith(
        1,
        'deliver',
        { deliveryId: 'wd-1' },
        { jobId: 'delivery-wd-1' },
      );
      expect(prismaMock.webhookDelivery.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          event: 'request.signed',
          organizationId: 'org-1',
          payload: expect.objectContaining({ event: 'request.signed', signerId: 's-1' }),
        }),
      });
    });

    it('does nothing when no endpoint is subscribed', async () => {
      prismaMock.webhookEndpoint.findMany.mockResolvedValue([]);
      expect(await service.emit('request.signed', { organizationId: 'org-1' })).toBe(0);
      expect(prismaMock.webhookDelivery.create).not.toHaveBeenCalled();
      expect(queueMock.add).not.toHaveBeenCalled();
    });
  });

  describe('sweepUnhealthyEndpoints', () => {
    const NOW = new Date('2026-10-07T12:00:00Z');
    const daysAgo = (n: number) => new Date(NOW.getTime() - n * 24 * 60 * 60 * 1000);

    const endpoint = (overrides: Record<string, unknown> = {}) => ({
      id: 'wh-old',
      organizationId: 'org-1',
      url: 'https://dead.example.com/hook',
      createdAt: daysAgo(30),
      ...overrides,
    });

    it('disables an endpoint that has failed for weeks, and tells the tenant why', async () => {
      prismaMock.webhookEndpoint.findMany.mockResolvedValue([endpoint()]);
      prismaMock.webhookDelivery.findFirst.mockResolvedValue(null); // never delivered
      prismaMock.webhookDelivery.count.mockResolvedValue(9);
      prismaMock.membership.findMany.mockResolvedValue([{ userId: 'u-1' }, { userId: 'u-2' }]);

      const result = await service.sweepUnhealthyEndpoints(NOW);

      expect(prismaMock.webhookEndpoint.update).toHaveBeenCalledWith({
        where: { id: 'wh-old' },
        data: { active: false, disabledAt: NOW },
      });
      expect(result.disabled).toEqual([
        expect.objectContaining({ id: 'wh-old', failures: 9, notified: 2 }),
      ]);
      // One notice per actionable member, naming the endpoint and the window.
      expect(notificationsMock.create).toHaveBeenCalledTimes(2);
      expect(notificationsMock.create).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: 'u-1',
          organizationId: 'org-1',
          type: 'webhook.endpoint_disabled',
          metadata: expect.objectContaining({ endpointId: 'wh-old', failures: 9, days: 30 }),
        }),
      );
      // Recipients are the people who can act: owners/admins or webhooks.manage.
      const recipientQuery = prismaMock.membership.findMany.mock.calls[0][0];
      expect(recipientQuery.where.OR[0]).toMatchObject({ role: { in: ['OWNER', 'ADMIN'] } });
      expect(JSON.stringify(recipientQuery.where.OR[1])).toContain('webhooks.manage');
    });

    it('measures from registration when there has never been a success', async () => {
      prismaMock.webhookEndpoint.findMany.mockResolvedValue([endpoint()]);
      prismaMock.webhookDelivery.findFirst.mockResolvedValue(null);
      prismaMock.webhookDelivery.count.mockResolvedValue(5);

      await service.sweepUnhealthyEndpoints(NOW);

      const countQuery = prismaMock.webhookDelivery.count.mock.calls[0][0];
      // Failures counted since the endpoint existed, not since a success that
      // never happened.
      expect(countQuery.where.OR).toEqual(
        expect.arrayContaining([expect.objectContaining({ lastAttemptAt: null })]),
      );
      expect(prismaMock.webhookEndpoint.update).toHaveBeenCalled();
    });

    it('disables an endpoint that used to work and then went quiet', async () => {
      prismaMock.webhookEndpoint.findMany.mockResolvedValue([endpoint()]);
      prismaMock.webhookDelivery.findFirst.mockResolvedValue({ deliveredAt: daysAgo(21) });
      prismaMock.webhookDelivery.count.mockResolvedValue(12);

      await service.sweepUnhealthyEndpoints(NOW);

      expect(prismaMock.webhookEndpoint.update).toHaveBeenCalledWith({
        where: { id: 'wh-old' },
        data: { active: false, disabledAt: NOW },
      });
    });

    it('leaves a recently successful endpoint alone', async () => {
      prismaMock.webhookEndpoint.findMany.mockResolvedValue([endpoint()]);
      prismaMock.webhookDelivery.findFirst.mockResolvedValue({ deliveredAt: daysAgo(1) });

      const result = await service.sweepUnhealthyEndpoints(NOW);

      expect(result.disabled).toEqual([]);
      expect(prismaMock.webhookDelivery.count).not.toHaveBeenCalled();
      expect(prismaMock.webhookEndpoint.update).not.toHaveBeenCalled();
    });

    it('does not disable a new endpoint on its first bad day', async () => {
      prismaMock.webhookEndpoint.findMany.mockResolvedValue([
        endpoint({ id: 'wh-new', createdAt: daysAgo(2) }),
      ]);
      prismaMock.webhookDelivery.findFirst.mockResolvedValue(null);
      prismaMock.webhookDelivery.count.mockResolvedValue(50);

      const result = await service.sweepUnhealthyEndpoints(NOW);

      expect(result.disabled).toEqual([]);
      expect(prismaMock.webhookEndpoint.update).not.toHaveBeenCalled();
    });

    it('does not disable on a single blip — the failure count is a second guard', async () => {
      prismaMock.webhookEndpoint.findMany.mockResolvedValue([endpoint()]);
      prismaMock.webhookDelivery.findFirst.mockResolvedValue(null);
      prismaMock.webhookDelivery.count.mockResolvedValue(2); // below the minimum of 5

      const result = await service.sweepUnhealthyEndpoints(NOW);

      expect(result.disabled).toEqual([]);
      expect(prismaMock.webhookEndpoint.update).not.toHaveBeenCalled();
      expect(notificationsMock.create).not.toHaveBeenCalled();
    });

    it('logs but still disables when the organization has nobody to notify', async () => {
      prismaMock.webhookEndpoint.findMany.mockResolvedValue([endpoint()]);
      prismaMock.webhookDelivery.findFirst.mockResolvedValue(null);
      prismaMock.webhookDelivery.count.mockResolvedValue(9);
      prismaMock.membership.findMany.mockResolvedValue([]);

      const result = await service.sweepUnhealthyEndpoints(NOW);

      expect(result.disabled[0]).toMatchObject({ id: 'wh-old', notified: 0 });
      expect(notificationsMock.create).not.toHaveBeenCalled();
    });
  });

  describe('setActive', () => {
    it('re-enables an endpoint without minting a new secret', async () => {
      prismaMock.webhookEndpoint.findFirst.mockResolvedValue({ id: 'wh-1' });
      prismaMock.webhookEndpoint.update.mockResolvedValue({ id: 'wh-1', active: true });

      await service.setActive(user, 'wh-1', true);

      expect(prismaMock.webhookEndpoint.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'wh-1' },
          data: { active: true, disabledAt: null },
        }),
      );
    });

    it('refuses an endpoint that belongs to another tenant', async () => {
      prismaMock.webhookEndpoint.findFirst.mockResolvedValue(null);
      await expect(service.setActive(user, 'wh-other', true)).rejects.toThrow(
        'Webhook endpoint not found',
      );
      expect(prismaMock.webhookEndpoint.update).not.toHaveBeenCalled();
    });

    it('returns fresh health so the console row updates without a refetch', async () => {
      prismaMock.webhookEndpoint.findFirst.mockResolvedValue({ id: 'wh-1' });
      prismaMock.webhookEndpoint.update.mockResolvedValue({
        id: 'wh-1',
        active: true,
        createdAt: new Date('2026-09-01T00:00:00Z'),
      });
      prismaMock.webhookDelivery.findFirst.mockResolvedValue(null);
      prismaMock.webhookDelivery.count.mockResolvedValue(0);

      const result = await service.setActive(user, 'wh-1', true);
      expect(result.health).toMatchObject({ status: 'healthy', disabledReason: null });
    });
  });

  describe('list health', () => {
    const NOW = new Date('2026-10-07T12:00:00Z');
    const daysAgo = (n: number) => new Date(NOW.getTime() - n * 24 * 60 * 60 * 1000);

    const row = (overrides: Record<string, unknown> = {}) => ({
      id: 'wh-1',
      url: 'https://hooks.example.com/signara',
      events: ['*'],
      description: null,
      active: true,
      disabledAt: null,
      createdAt: daysAgo(40),
      ...overrides,
    });

    beforeEach(() => {
      jest.useFakeTimers().setSystemTime(NOW);
    });

    afterEach(() => {
      jest.useRealTimers();
    });

    it('reports a healthy endpoint with its last success and no reason', async () => {
      prismaMock.webhookEndpoint.findMany.mockResolvedValue([row()]);
      prismaMock.webhookDelivery.findFirst
        .mockResolvedValueOnce({ deliveredAt: daysAgo(1) }) // last success
        .mockResolvedValueOnce(null); // last failure
      prismaMock.webhookDelivery.count.mockResolvedValue(0);

      const [endpoint] = await service.list(user);

      expect(endpoint.health).toMatchObject({
        status: 'healthy',
        failuresSinceSuccess: 0,
        lastSuccessAt: daysAgo(1),
        lastError: null,
        disabledReason: null,
      });
    });

    it('marks a live endpoint failing and carries the last error', async () => {
      prismaMock.webhookEndpoint.findMany.mockResolvedValue([row()]);
      prismaMock.webhookDelivery.findFirst
        .mockResolvedValueOnce({ deliveredAt: daysAgo(3) })
        .mockResolvedValueOnce({ error: 'HTTP 500', lastAttemptAt: daysAgo(1) });
      prismaMock.webhookDelivery.count.mockResolvedValue(4);

      const [endpoint] = await service.list(user);

      expect(endpoint.health).toMatchObject({
        status: 'failing',
        failuresSinceSuccess: 4,
        lastError: 'HTTP 500',
        disabledReason: null,
      });
    });

    it('does not call a stale failure current trouble after a later success', async () => {
      prismaMock.webhookEndpoint.findMany.mockResolvedValue([row()]);
      prismaMock.webhookDelivery.findFirst
        .mockResolvedValueOnce({ deliveredAt: daysAgo(1) }) // last success
        .mockResolvedValueOnce({ error: 'HTTP 500', lastAttemptAt: daysAgo(5) }); // older failure
      prismaMock.webhookDelivery.count.mockResolvedValue(3);

      const [endpoint] = await service.list(user);
      expect(endpoint.health.status).toBe('healthy');
    });

    it('explains why a disabled endpoint stopped, in one actionable sentence', async () => {
      prismaMock.webhookEndpoint.findMany.mockResolvedValue([
        row({ active: false, disabledAt: NOW }),
      ]);
      prismaMock.webhookDelivery.findFirst
        .mockResolvedValueOnce(null) // never delivered successfully
        .mockResolvedValueOnce({ error: 'getaddrinfo ENOTFOUND', lastAttemptAt: daysAgo(1) });
      prismaMock.webhookDelivery.count.mockResolvedValue(9);

      const [endpoint] = await service.list(user);

      expect(endpoint.health.status).toBe('disabled');
      expect(endpoint.health.failuresSinceSuccess).toBe(9);
      expect(endpoint.health.disabledReason).toMatch(
        /9 failed delivery attempt\(s\) in 40 day\(s\)/,
      );
      expect(endpoint.health.disabledReason).toContain('getaddrinfo ENOTFOUND');
    });
  });

  describe('deliver', () => {
    const endpoint = {
      url: 'https://hooks.example.com/signara',
      secret: 'whsec_test',
      active: true,
    };

    const delivery = {
      id: 'wd-1',
      event: 'request.signed',
      attempts: 0,
      payload: { event: 'request.signed', requestId: 'req-1' },
      endpoint,
    };

    afterEach(() => {
      jest.restoreAllMocks();
    });

    it('signs the body and records DELIVERED on a 2xx', async () => {
      prismaMock.webhookDelivery.findUnique.mockResolvedValue(delivery);
      const fetchMock = jest
        .spyOn(global, 'fetch')
        .mockResolvedValue(new Response('ok', { status: 200 }));

      await service.deliver('wd-1');

      const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      const headers = init.headers as Record<string, string>;
      const body = init.body as string;
      const timestamp = Number(/^t=(\d+),v1=/.exec(headers['x-signara-signature'])?.[1]);

      expect(headers['x-signara-event']).toBe('request.signed');
      expect(headers['x-signara-delivery']).toBe('wd-1');
      expect(headers['x-signara-signature']).toBe(
        signWebhookPayload('whsec_test', timestamp, body),
      );
      // A redirect is refused: it could hand us off to a private URL that the
      // registration-time check never saw.
      expect(init).toMatchObject({ method: 'POST', redirect: 'error' });

      expect(prismaMock.webhookDelivery.update).toHaveBeenCalledWith({
        where: { id: 'wd-1' },
        data: expect.objectContaining({
          status: WebhookDeliveryStatus.DELIVERED,
          attempts: 1,
          responseStatus: 200,
        }),
      });
    });

    it('records FAILED and throws on a non-2xx so the queue retries', async () => {
      prismaMock.webhookDelivery.findUnique.mockResolvedValue(delivery);
      jest.spyOn(global, 'fetch').mockResolvedValue(new Response('nope', { status: 500 }));

      await expect(service.deliver('wd-1')).rejects.toThrow('HTTP 500');

      expect(prismaMock.webhookDelivery.update).toHaveBeenCalledWith({
        where: { id: 'wd-1' },
        data: expect.objectContaining({
          status: WebhookDeliveryStatus.FAILED,
          attempts: 1,
          responseStatus: 500,
          error: 'HTTP 500',
        }),
      });
    });

    it('records a transport error without inventing a status', async () => {
      prismaMock.webhookDelivery.findUnique.mockResolvedValue(delivery);
      jest.spyOn(global, 'fetch').mockRejectedValue(new Error('getaddrinfo ENOTFOUND'));

      await expect(service.deliver('wd-1')).rejects.toThrow('ENOTFOUND');

      expect(prismaMock.webhookDelivery.update).toHaveBeenCalledWith({
        where: { id: 'wd-1' },
        data: expect.objectContaining({
          status: WebhookDeliveryStatus.FAILED,
          error: 'getaddrinfo ENOTFOUND',
        }),
      });
    });

    it('does not retry a disabled endpoint', async () => {
      prismaMock.webhookDelivery.findUnique.mockResolvedValue({
        ...delivery,
        endpoint: { ...endpoint, active: false },
      });
      const fetchMock = jest.spyOn(global, 'fetch');

      await expect(service.deliver('wd-1')).resolves.toBeUndefined();

      expect(fetchMock).not.toHaveBeenCalled();
      expect(prismaMock.webhookDelivery.update).toHaveBeenCalledWith({
        where: { id: 'wd-1' },
        data: expect.objectContaining({
          status: WebhookDeliveryStatus.FAILED,
          error: 'endpoint disabled',
        }),
      });
    });

    it('silently ignores a delivery whose endpoint was deleted while queued', async () => {
      prismaMock.webhookDelivery.findUnique.mockResolvedValue(null);
      await expect(service.deliver('wd-gone')).resolves.toBeUndefined();
      expect(prismaMock.webhookDelivery.update).not.toHaveBeenCalled();
    });
  });
});
