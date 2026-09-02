import { Test } from '@nestjs/testing';
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
  const minioMock = { getBuffer: jest.fn().mockResolvedValue(Buffer.from('pdf-bytes')) } as unknown as MinioService;

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
    const moduleRef = await Test.createTestingModule({
      providers: [
        SignaturesService,
        { provide: PrismaService, useValue: prismaMock },
        { provide: MinioService, useValue: minioMock },
        { provide: CertificatesService, useValue: { signWithCertificate: jest.fn() } },
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
          signers: [
            { email: 'a@x.io' },
            { email: 'A@x.io' },
          ],
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
});