import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { createHmac } from 'node:crypto';
import { BadRequestException } from '@nestjs/common';
import { WebhookDeliveryStatus } from '@prisma/client';
import { isPrivateHost, signWebhookPayload, WebhooksService } from './webhooks.service';
import { PrismaService } from '../../prisma/prisma.service';
import { AuthenticatedUser } from '../../common/types';

describe('WebhooksService', () => {
  let service: WebhooksService;

  const prismaMock = {
    webhookEndpoint: {
      create: jest.fn(),
      findMany: jest.fn().mockResolvedValue([]),
      findFirst: jest.fn(),
      delete: jest.fn(),
    },
    webhookDelivery: {
      create: jest.fn(),
      findUnique: jest.fn(),
      findMany: jest.fn(),
      update: jest.fn().mockResolvedValue({}),
    },
  };

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
    configValues = { 'webhooks.allowPrivate': false, 'webhooks.timeoutMs': 10_000 };
    const moduleRef = await Test.createTestingModule({
      providers: [
        WebhooksService,
        { provide: PrismaService, useValue: prismaMock },
        { provide: ConfigService, useValue: configMock },
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
