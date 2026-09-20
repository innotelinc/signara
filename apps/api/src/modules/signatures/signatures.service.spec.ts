import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { DocumentStatus, SigningMode, SignerRole, SignerStatus } from '@prisma/client';
import { SignaturesService } from './signatures.service';
import { PrismaService } from '../../prisma/prisma.service';
import { MinioService } from '../../storage/minio.service';
import { CertificatesService } from '../certificates/certificates.service';
import { Queue } from 'bullmq';

describe('SignaturesService', () => {
  let service: SignaturesService;

  const prismaMock = {
    signingRequest: {
      create: jest.fn(),
      findUnique: jest.fn(),
      findUniqueOrThrow: jest.fn(),
      findFirst: jest.fn(),
      findMany: jest.fn(),
      update: jest.fn(),
      count: jest.fn(),
    },
    signer: {
      findUnique: jest.fn(),
      update: jest.fn(),
      findMany: jest.fn(),
    },
    document: { findFirst: jest.fn(), findUniqueOrThrow: jest.fn(), update: jest.fn() },
    signature: { create: jest.fn() },
    signatureEvent: { create: jest.fn(), findMany: jest.fn() },
    $transaction: jest.fn((operations: Promise<unknown>[]) => Promise.all(operations)),
  };

  const queueMock = { add: jest.fn().mockResolvedValue(undefined) } as unknown as Queue;
  // Mutable, and reset per test, so no case inherits another's configuration.
  let configValues: Record<string, unknown> = {};
  const configMock = {
    get: jest.fn((key: string) => configValues[key]),
  } as unknown as ConfigService;
  const minioMock = {
    getBuffer: jest.fn().mockResolvedValue(Buffer.from('pdf-bytes')),
  } as unknown as MinioService;

  const user = {
    id: 'u-1',
    email: 'owner@signara.local',
    displayName: 'Owner',
    platformRole: 'USER' as const,
    sub: 'sub-1',
    groups: [],
    org: { id: 'org-1', slug: 'acme', role: 'OWNER', permissions: [] },
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    configValues = {
      'reminders.afterDays': 3,
      'reminders.max': 3,
      'reminders.sweepIntervalMinutes': 360,
      'smtp.host': 'smtp.example.com',
    };
    const moduleRef = await Test.createTestingModule({
      providers: [
        SignaturesService,
        { provide: PrismaService, useValue: prismaMock },
        { provide: MinioService, useValue: minioMock },
        { provide: CertificatesService, useValue: { signWithCertificate: jest.fn() } },
        { provide: ConfigService, useValue: configMock },
        { provide: 'BullQueue_signing', useValue: queueMock },
      ],
    }).compile();

    service = moduleRef.get(SignaturesService);
  });

  describe('createRequest', () => {
    it('creates a sequential request with the first signer invited', async () => {
      const document = { id: 'doc-1', status: 'DRAFT', title: 'Contract' };
      const created = {
        id: 'req-1',
        organizationId: 'org-1',
        documentId: 'doc-1',
        status: 'AWAITING_SIGNATURE',
        mode: 'SEQUENTIAL',
        signers: [
          { id: 's-1', email: 'a@x.io', status: 'INVITED' },
          { id: 's-2', email: 'b@x.io', status: 'PENDING' },
        ],
        document,
      };

      prismaMock.document.findFirst.mockResolvedValue(document);
      prismaMock.signingRequest.create.mockResolvedValue(created);
      prismaMock.signingRequest.findUniqueOrThrow.mockResolvedValue({ ...created, document });

      const result = await service.createRequest(user, {
        documentId: 'doc-1',
        signers: [
          { email: 'a@x.io', orderIndex: 0 },
          { email: 'b@x.io', orderIndex: 1 },
        ],
        mode: SigningMode.SEQUENTIAL,
      });

      expect(prismaMock.document.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: { status: DocumentStatus.AWAITING_SIGNATURE } }),
      );
      // In sequential mode only signer 1 (index 0) is invited initially
      expect(created.signers[0].status).toBe(SignerStatus.INVITED);
      expect(created.signers[1].status).toBe(SignerStatus.PENDING);
      expect(queueMock.add).toHaveBeenCalledTimes(1);
      expect(result).toBeDefined();
    });

    it('rejects duplicate signer emails', async () => {
      prismaMock.document.findFirst.mockResolvedValue({ id: 'doc-1', status: 'DRAFT' });
      await expect(
        service.createRequest(user, {
          documentId: 'doc-1',
          signers: [{ email: 'a@x.io' }, { email: 'A@x.io' }],
        }),
      ).rejects.toThrow('Duplicate signer emails');
    });

    it('rejects an empty signer list', async () => {
      prismaMock.document.findFirst.mockResolvedValue({ id: 'doc-1', status: 'DRAFT' });
      await expect(
        service.createRequest(user, { documentId: 'doc-1', signers: [] }),
      ).rejects.toThrow('At least one signer is required');
    });
  });

  describe('decline in sequential mode', () => {
    it('flips the request to IN_PROGRESS after a decline', async () => {
      prismaMock.signer.findUnique.mockResolvedValue({
        id: 's-1',
        requestId: 'req-1',
        request: { mode: SigningMode.SEQUENTIAL, status: 'AWAITING_SIGNATURE' },
      });
      await service.decline('tok-123', 'Not applicable');
      expect(prismaMock.signer.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: { status: SignerStatus.DECLINED } }),
      );
      expect(prismaMock.signingRequest.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: { status: DocumentStatus.IN_PROGRESS } }),
      );
    });
  });

  describe('reminders (issue #82)', () => {
    const request = {
      id: 'req-1',
      organizationId: 'org-1',
      status: DocumentStatus.AWAITING_SIGNATURE,
      mode: SigningMode.SEQUENTIAL,
    };

    const signerRow = (over: Record<string, unknown> = {}) => ({
      id: 's-1',
      requestId: 'req-1',
      role: SignerRole.SIGNER,
      orderIndex: 0,
      status: SignerStatus.INVITED,
      reminderCount: 0,
      request: { mode: SigningMode.SEQUENTIAL, status: DocumentStatus.AWAITING_SIGNATURE },
      ...over,
    });

    it('queues the mail as a reminder, not an invitation', async () => {
      prismaMock.signingRequest.findFirst.mockResolvedValue(request);
      prismaMock.signer.findMany.mockReset();
      prismaMock.signer.findMany
        .mockResolvedValueOnce([signerRow()]) // eligibleReminderTargets
        .mockResolvedValue([]); // canSignerAct: nobody earlier to wait on
      prismaMock.signatureEvent.findMany.mockResolvedValue([]);

      const result = await service.remind(user, 'req-1');

      expect(result).toEqual({ success: true, enqueued: 1 });
      expect(queueMock.add).toHaveBeenCalledWith(
        'send-signing-reminder',
        expect.objectContaining({ kind: 'reminder', signerId: 's-1' }),
        expect.anything(),
      );
    });

    it('does not chase a signer the sequential flow has not reached', async () => {
      prismaMock.signingRequest.findFirst.mockResolvedValue(request);
      prismaMock.signer.findMany.mockReset();
      prismaMock.signer.findMany
        .mockResolvedValueOnce([signerRow({ id: 's-2', orderIndex: 1 })])
        // canSignerAct: the signer ahead of s-2 is still INVITED, so s-2's turn
        // has not come.
        .mockResolvedValue([{ status: SignerStatus.INVITED }]);
      prismaMock.signatureEvent.findMany.mockResolvedValue([]);

      const result = await service.remind(user, 'req-1', 's-2');

      expect(result.enqueued).toBe(0);
      expect(queueMock.add).not.toHaveBeenCalled();
    });

    it('refuses a reminder once the request is no longer awaiting signatures', async () => {
      prismaMock.signingRequest.findFirst.mockResolvedValue({
        ...request,
        status: DocumentStatus.COMPLETED,
      });

      await expect(service.remind(user, 'req-1')).rejects.toThrow('no longer awaiting signatures');
    });

    it('does nothing when no mail transport is configured', async () => {
      configValues['smtp.host'] = '';
      prismaMock.signingRequest.findMany.mockResolvedValue([
        { id: 'req-1', mode: SigningMode.PARALLEL },
      ]);

      const result = await service.sweepDueReminders();

      expect(result).toEqual({ requests: 0, enqueued: 0 });
      // Not even the lookup should happen: with nowhere to send, a swept request
      // would only get a phantom REMINDED event and a spent reminder slot.
      expect(prismaMock.signingRequest.findMany).not.toHaveBeenCalled();
      expect(queueMock.add).not.toHaveBeenCalled();
    });

    it('sweeps due requests and stops at the reminder cap', async () => {
      prismaMock.signingRequest.findMany.mockResolvedValue([
        { id: 'req-1', mode: SigningMode.PARALLEL },
      ]);
      prismaMock.signer.findMany.mockReset();
      prismaMock.signer.findMany.mockResolvedValue([
        signerRow({ request: { mode: SigningMode.PARALLEL, status: 'AWAITING_SIGNATURE' } }),
        signerRow({
          id: 's-2',
          orderIndex: 1,
          status: SignerStatus.VIEWED,
          reminderCount: 3, // at REMINDER_MAX, so it must be left alone
          request: { mode: SigningMode.PARALLEL, status: 'AWAITING_SIGNATURE' },
        }),
      ]);
      prismaMock.signatureEvent.findMany.mockResolvedValue([]);

      const result = await service.sweepDueReminders();

      expect(result).toEqual({ requests: 1, enqueued: 1 });
      expect(queueMock.add).toHaveBeenCalledTimes(1);
      expect(queueMock.add).toHaveBeenCalledWith(
        'send-signing-reminder',
        expect.objectContaining({ signerId: 's-1', kind: 'reminder' }),
        expect.anything(),
      );
    });
  });
});
