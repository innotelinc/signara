import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import {
  DocumentStatus,
  FieldType,
  SignatureEventType,
  SigningMode,
  SignerRole,
  SignerStatus,
} from '@prisma/client';
import { SignaturesService } from './signatures.service';
import { PrismaService } from '../../prisma/prisma.service';
import { MinioService } from '../../storage/minio.service';
import { CertificatesService } from '../certificates/certificates.service';
import { WebhooksService } from '../webhooks/webhooks.service';
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
    templateField: { findMany: jest.fn() },
    requestField: { findMany: jest.fn(), createMany: jest.fn(), update: jest.fn() },
    $transaction: jest.fn((operations: Promise<unknown>[]) => Promise.all(operations)),
  };

  const queueMock = { add: jest.fn().mockResolvedValue(undefined) } as unknown as Queue;
  const webhooksMock = { emit: jest.fn().mockResolvedValue(1) };
  // Mutable, and reset per test, so no case inherits another's configuration.
  let configValues: Record<string, unknown> = {};
  const configMock = {
    get: jest.fn((key: string) => configValues[key]),
  } as unknown as ConfigService;
  const minioMock = {
    getBuffer: jest.fn().mockResolvedValue(Buffer.from('pdf-bytes')),
    getPresignedUrl: jest.fn().mockResolvedValue('https://minio.test/document.pdf'),
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
    // clearAllMocks keeps implementations, so these two would otherwise leak
    // between cases (`findUnique` is set to a value by the webhook tests).
    prismaMock.signingRequest.findUnique.mockReset();
    webhooksMock.emit.mockReset().mockResolvedValue(1);
    // Reset rather than clear: `clearAllMocks` leaves implementations, and these
    // two must answer an array (a request with no placements) for every case that
    // does not set them up itself.
    prismaMock.templateField.findMany.mockReset().mockResolvedValue([]);
    prismaMock.requestField.findMany.mockReset().mockResolvedValue([]);
    prismaMock.requestField.update.mockReset().mockResolvedValue({});
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
        { provide: WebhooksService, useValue: webhooksMock },
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

  describe('webhook event mapping (issue #85)', () => {
    type RecordEvent = (
      requestId: string,
      type: SignatureEventType,
      signerId: string | null,
      metadata: Record<string, unknown>,
    ) => Promise<void>;

    // The mapping is the contract with subscribers, so it is pinned directly:
    // every audited event maps to exactly one webhook event, or deliberately
    // to none. Getting this wrong is invisible until a customer notices.
    const record = (type: SignatureEventType, metadata: Record<string, unknown> = {}) =>
      (service as unknown as { recordEvent: RecordEvent }).recordEvent(
        'req-1',
        type,
        's-1',
        metadata,
      );

    beforeEach(() => {
      prismaMock.signingRequest.findUnique.mockResolvedValue({ organizationId: 'org-1' });
    });

    it.each([
      [SignatureEventType.CREATED, {}, 'request.created'],
      [SignatureEventType.VIEWED, {}, 'request.viewed'],
      [SignatureEventType.SIGNED, {}, 'request.signed'],
      [SignatureEventType.SIGNED, { completed: true }, 'request.completed'],
      [SignatureEventType.DECLINED, {}, 'request.declined'],
      [SignatureEventType.CANCELLED, {}, 'request.cancelled'],
      [SignatureEventType.EXPIRED, {}, 'request.expired'],
      [SignatureEventType.REMINDED, {}, 'request.reminded'],
    ])('maps %s to %s', async (type, metadata, expected) => {
      await record(type as SignatureEventType, metadata as Record<string, unknown>);
      expect(webhooksMock.emit).toHaveBeenCalledWith(
        expected,
        expect.objectContaining({ organizationId: 'org-1', requestId: 'req-1' }),
      );
    });

    it.each([
      SignatureEventType.INVITED,
      SignatureEventType.VOIDED,
      SignatureEventType.APPROVED,
      SignatureEventType.REJECTED,
      SignatureEventType.DOWNLOADED,
      SignatureEventType.EMAIL_FAILED,
      // A handover is deliberately not a delivery: nothing was sent to a
      // subscriber's signer, so `request.sent` would be a lie.
      SignatureEventType.HANDED_OVER,
    ])('emits nothing for the internal event %s', async (type) => {
      await record(type as SignatureEventType);
      expect(webhooksMock.emit).not.toHaveBeenCalled();
    });

    it('still records the audit event when the webhook fan-out fails', async () => {
      webhooksMock.emit.mockRejectedValueOnce(new Error('redis unavailable'));
      await expect(record(SignatureEventType.SIGNED)).resolves.toBeUndefined();
      expect(prismaMock.signatureEvent.create).toHaveBeenCalled();
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

  describe('in-person signing (issue #88)', () => {
    const signerRow = (over: Record<string, unknown> = {}) => ({
      id: 's-1',
      requestId: 'req-1',
      email: 'signer@x.io',
      role: SignerRole.SIGNER,
      orderIndex: 0,
      status: SignerStatus.INVITED,
      token: 'sgn_token_one',
      authMethod: null,
      userId: null,
      ...over,
    });

    const requestRow = (over: Record<string, unknown> = {}) => ({
      id: 'req-1',
      organizationId: 'org-1',
      status: DocumentStatus.AWAITING_SIGNATURE,
      mode: SigningMode.SEQUENTIAL,
      deadline: null,
      signers: [signerRow(), signerRow({ id: 's-2', orderIndex: 1, status: SignerStatus.PENDING })],
      ...over,
    });

    beforeEach(() => {
      configValues['app.webUrl'] = 'https://app.example.test/';
    });

    it('hands the waiting signer a link and queues no mail', async () => {
      prismaMock.signingRequest.findFirst.mockResolvedValue(requestRow());
      prismaMock.signer.findMany.mockResolvedValue([]);

      const result = await service.inPersonSession(user, 'req-1');

      // The URL is the same one the invitation mailer would have sent, built the
      // same way — a handover must not produce a link the signing room treats
      // differently.
      expect(result).toEqual({
        requestId: 'req-1',
        signerId: 's-1',
        signerEmail: 'signer@x.io',
        url: 'https://app.example.test/sign/sgn_token_one',
      });
      // Marked on the signer, because that is what reaches the signature.
      expect(prismaMock.signer.update).toHaveBeenCalledWith({
        where: { id: 's-1' },
        data: { authMethod: 'in_person' },
      });
      // Its own event, not an INVITED: the trail has to tell a handover from an
      // emailed invitation.
      expect(prismaMock.signatureEvent.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          type: SignatureEventType.HANDED_OVER,
          signerId: 's-1',
          metadata: expect.objectContaining({ handedOverBy: user.email, inPerson: true }),
        }),
      });
      // The whole point: no email round trip.
      expect(queueMock.add).not.toHaveBeenCalled();
    });

    it('refuses a signer the sequential flow has not reached', async () => {
      prismaMock.signingRequest.findFirst.mockResolvedValue(requestRow());
      prismaMock.signer.findMany.mockResolvedValue([{ status: SignerStatus.INVITED }]);

      await expect(service.inPersonSession(user, 'req-1', 's-2')).rejects.toThrow(
        "It is not that signer's turn yet",
      );
      expect(prismaMock.signer.update).not.toHaveBeenCalled();
    });

    it('refuses to guess which signer is present on a parallel request', async () => {
      prismaMock.signingRequest.findFirst.mockResolvedValue(
        requestRow({
          mode: SigningMode.PARALLEL,
          signers: [
            signerRow(),
            signerRow({ id: 's-2', orderIndex: 1, status: SignerStatus.INVITED }),
          ],
        }),
      );

      await expect(service.inPersonSession(user, 'req-1')).rejects.toThrow('signerId is required');
      // Nothing was marked and nothing was recorded: a refused handover must not
      // leave a trace that says one happened.
      expect(prismaMock.signer.update).not.toHaveBeenCalled();
      expect(prismaMock.signatureEvent.create).not.toHaveBeenCalled();
    });

    it('hands over a named signer when a parallel request releases several', async () => {
      prismaMock.signingRequest.findFirst.mockResolvedValue(
        requestRow({
          mode: SigningMode.PARALLEL,
          signers: [
            signerRow(),
            signerRow({
              id: 's-2',
              orderIndex: 1,
              email: 'second@x.io',
              status: SignerStatus.INVITED,
              token: 'sgn_token_two',
            }),
          ],
        }),
      );
      prismaMock.signer.findMany.mockResolvedValue([]);

      const result = await service.inPersonSession(user, 'req-1', 's-2');

      expect(result).toEqual({
        requestId: 'req-1',
        signerId: 's-2',
        signerEmail: 'second@x.io',
        url: 'https://app.example.test/sign/sgn_token_two',
      });
    });

    it('never hands a carbon-copy recipient a signing session', async () => {
      prismaMock.signingRequest.findFirst.mockResolvedValue(
        requestRow({
          signers: [signerRow({ id: 'cc-1', role: SignerRole.CC, status: SignerStatus.INVITED })],
        }),
      );

      await expect(service.inPersonSession(user, 'req-1', 'cc-1')).rejects.toThrow(
        'not on this request',
      );
    });

    it('refuses a signer who has already signed', async () => {
      prismaMock.signingRequest.findFirst.mockResolvedValue(
        requestRow({ signers: [signerRow({ status: SignerStatus.SIGNED })] }),
      );

      await expect(service.inPersonSession(user, 'req-1', 's-1')).rejects.toThrow('already signed');
    });

    it('refuses a request that is no longer active', async () => {
      prismaMock.signingRequest.findFirst.mockResolvedValue(
        requestRow({ status: DocumentStatus.COMPLETED }),
      );

      await expect(service.inPersonSession(user, 'req-1')).rejects.toThrow('no longer active');
    });

    it('expires a request whose deadline has passed instead of handing it over', async () => {
      prismaMock.signingRequest.findFirst.mockResolvedValue(
        requestRow({ deadline: new Date(Date.now() - 60_000) }),
      );

      await expect(service.inPersonSession(user, 'req-1')).rejects.toThrow('expired');
      expect(prismaMock.signingRequest.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: { status: DocumentStatus.EXPIRED } }),
      );
    });

    it('refuses when no signer is waiting at all', async () => {
      prismaMock.signingRequest.findFirst.mockResolvedValue(
        requestRow({
          signers: [signerRow({ status: SignerStatus.SIGNED })],
        }),
      );

      await expect(service.inPersonSession(user, 'req-1')).rejects.toThrow('No signer is waiting');
    });

    it('carries the handover into the signature it produces', async () => {
      // The signature records the operator's IP and user agent — that is what a
      // handover means — so the trail has to say *why* those are not the
      // signer's, which is the inPerson marker on the SIGNED event.
      prismaMock.signer.findUnique.mockResolvedValue({
        id: 's-1',
        requestId: 'req-1',
        email: 'signer@x.io',
        role: SignerRole.SIGNER,
        status: SignerStatus.VIEWED,
        orderIndex: 0,
        authMethod: 'in_person',
        userId: null,
        request: {
          status: DocumentStatus.AWAITING_SIGNATURE,
          documentId: 'doc-1',
          mode: SigningMode.PARALLEL,
          organizationId: 'org-1',
          deadline: null,
        },
      });
      prismaMock.document.findUniqueOrThrow.mockResolvedValue({
        id: 'doc-1',
        fileKey: 'org-1/documents/doc-1.pdf',
      });
      prismaMock.signature.create.mockResolvedValue({
        id: 'sig-1',
        type: 'TYPED',
        certificateSerial: null,
        certificateId: null,
      });
      prismaMock.signingRequest.findUnique.mockResolvedValue({
        id: 'req-1',
        documentId: 'doc-1',
        signers: [],
      });

      await service.sign(
        'sgn_token_one',
        { type: 'TYPED' },
        {
          ipAddress: '10.0.0.9',
          userAgent: 'reception-tablet',
        },
      );

      expect(prismaMock.signatureEvent.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          type: SignatureEventType.SIGNED,
          ipAddress: '10.0.0.9',
          metadata: expect.objectContaining({ inPerson: true }),
        }),
      });
    });
  });

  describe('placed fields reaching a signer (issue #81)', () => {
    const templateField = (over: Record<string, unknown> = {}) => ({
      id: 'tf-1',
      templateId: 'tpl-1',
      type: FieldType.NAME,
      name: 'Full name',
      key: 'full_name',
      isRequired: true,
      pageNumber: 1,
      assigneeOrder: 0,
      x: 10,
      y: 60,
      width: 30,
      height: 6,
      options: null,
      createdAt: new Date('2026-09-01T00:00:00Z'),
      ...over,
    });

    const documentRow = { id: 'doc-1', status: 'DRAFT', title: 'Contract', templateId: 'tpl-1' };

    const requestRow = {
      id: 'req-1',
      organizationId: 'org-1',
      documentId: 'doc-1',
      status: 'AWAITING_SIGNATURE',
      mode: 'SEQUENTIAL',
      signers: [
        { id: 's-1', email: 'a@x.io', role: SignerRole.SIGNER, orderIndex: 0, status: 'INVITED' },
        { id: 's-2', email: 'b@x.io', role: SignerRole.SIGNER, orderIndex: 1, status: 'PENDING' },
      ],
      document: documentRow,
    };

    const signingSigner = (over: Record<string, unknown> = {}) => ({
      id: 's-1',
      requestId: 'req-1',
      email: 'a@x.io',
      role: SignerRole.SIGNER,
      status: SignerStatus.VIEWED,
      orderIndex: 0,
      authMethod: null,
      userId: null,
      token: 'sgn_token_one',
      request: {
        status: DocumentStatus.AWAITING_SIGNATURE,
        documentId: 'doc-1',
        mode: SigningMode.PARALLEL,
        organizationId: 'org-1',
        deadline: null,
        document: {
          id: 'doc-1',
          title: 'Contract',
          fileName: 'contract.pdf',
          fileKey: 'org-1/documents/doc-1.pdf',
        },
      },
      ...over,
    });

    const primeSign = () => {
      prismaMock.signer.findUnique.mockResolvedValue(signingSigner());
      prismaMock.document.findUniqueOrThrow.mockResolvedValue({
        id: 'doc-1',
        fileKey: 'org-1/documents/doc-1.pdf',
      });
      prismaMock.signature.create.mockResolvedValue({
        id: 'sig-1',
        type: 'TYPED',
        certificateSerial: null,
        certificateId: null,
      });
      prismaMock.signingRequest.findUnique.mockResolvedValue({
        id: 'req-1',
        documentId: 'doc-1',
        signers: [],
      });
    };

    const placementRow = (over: Record<string, unknown> = {}) => ({
      id: 'rf-1',
      requestId: 'req-1',
      signerId: 's-1',
      type: FieldType.NAME,
      name: 'Full name',
      key: 'full_name',
      isRequired: true,
      pageNumber: 1,
      ...over,
    });

    it('copies a template\u2019s placements onto the request, binding each to its signer', async () => {
      prismaMock.signingRequest.create.mockResolvedValue(requestRow);
      prismaMock.signingRequest.findUniqueOrThrow.mockResolvedValue(requestRow);
      prismaMock.document.findFirst.mockResolvedValue(documentRow);
      prismaMock.templateField.findMany.mockResolvedValue([
        templateField(),
        templateField({
          id: 'tf-2',
          type: FieldType.DATE,
          name: 'Date',
          key: 'date',
          assigneeOrder: 1,
        }),
      ]);

      await service.createRequest(user, {
        documentId: 'doc-1',
        signers: [
          { email: 'a@x.io', orderIndex: 0 },
          { email: 'b@x.io', orderIndex: 1 },
        ],
      });

      expect(prismaMock.requestField.createMany).toHaveBeenCalledTimes(1);
      const data = prismaMock.requestField.createMany.mock.calls[0][0].data;
      expect(data).toHaveLength(2);
      // The binding is the whole point: placement -> concrete signer row, in the
      // order the sender chose, not by matching on email or position later.
      expect(data[0]).toEqual(
        expect.objectContaining({ requestId: 'req-1', signerId: 's-1', key: 'full_name' }),
      );
      expect(data[1]).toEqual(
        expect.objectContaining({ requestId: 'req-1', signerId: 's-2', key: 'date' }),
      );
    });

    it('refuses a placement aimed at a signer the request does not have', async () => {
      prismaMock.document.findFirst.mockResolvedValue(documentRow);
      prismaMock.templateField.findMany.mockResolvedValue([
        templateField({ id: 'tf-9', name: 'Notary', assigneeOrder: 2 }),
      ]);

      await expect(
        service.createRequest(user, {
          documentId: 'doc-1',
          signers: [{ email: 'a@x.io', orderIndex: 0 }],
        }),
      ).rejects.toThrow('assigned to signer 3');
      expect(prismaMock.signingRequest.create).not.toHaveBeenCalled();
    });

    it('refuses an attachment placement, which a signing room cannot collect', async () => {
      prismaMock.document.findFirst.mockResolvedValue(documentRow);
      prismaMock.templateField.findMany.mockResolvedValue([
        templateField({ id: 'tf-3', type: FieldType.ATTACHMENT, name: 'ID scan', key: 'id_scan' }),
      ]);

      await expect(
        service.createRequest(user, {
          documentId: 'doc-1',
          signers: [{ email: 'a@x.io', orderIndex: 0 }],
        }),
      ).rejects.toThrow('cannot collect yet');
    });

    it('gives a signer only their own placements in the public session', async () => {
      prismaMock.signer.findUnique.mockResolvedValue(signingSigner());
      prismaMock.requestField.findMany.mockResolvedValue([placementRow()]);

      const session = await service.publicSession('sgn_token_one', {});

      expect(prismaMock.requestField.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { requestId: 'req-1', signerId: 's-1' } }),
      );
      expect(session.requestedFields).toEqual([placementRow()]);
    });

    it('refuses a signature while a required placed field is blank', async () => {
      primeSign();
      prismaMock.requestField.findMany.mockResolvedValue([placementRow()]);

      await expect(
        service.sign(
          'sgn_token_one',
          { type: 'TYPED' },
          { ipAddress: '10.0.0.9', userAgent: 'tablet' },
        ),
      ).rejects.toThrow('Complete the required field(s) first: Full name');
      expect(prismaMock.signature.create).not.toHaveBeenCalled();
      expect(prismaMock.requestField.update).not.toHaveBeenCalled();
    });

    it('refuses a value for a field that is not this signer\u2019s', async () => {
      primeSign();
      prismaMock.requestField.findMany.mockResolvedValue([placementRow({ isRequired: false })]);

      await expect(
        service.sign(
          'sgn_token_one',
          { type: 'TYPED', fields: [{ id: 'rf-someone-else', value: 'x' }] },
          { ipAddress: '10.0.0.9', userAgent: 'tablet' },
        ),
      ).rejects.toThrow('Unknown field(s) for this signer');
    });

    it('records the values the signer supplied and counts them in the trail', async () => {
      primeSign();
      prismaMock.requestField.findMany.mockResolvedValue([
        placementRow(),
        placementRow({
          id: 'rf-2',
          type: FieldType.CHECKBOX,
          name: 'I agree',
          key: 'agree',
          isRequired: true,
        }),
      ]);

      await service.sign(
        'sgn_token_one',
        {
          type: 'TYPED',
          fields: [
            { id: 'rf-1', value: 'Ada Lovelace' },
            { id: 'rf-2', value: true },
          ],
        },
        { ipAddress: '10.0.0.9', userAgent: 'tablet' },
      );

      expect(prismaMock.requestField.update).toHaveBeenCalledTimes(2);
      expect(prismaMock.requestField.update).toHaveBeenCalledWith({
        where: { id: 'rf-1' },
        data: { value: 'Ada Lovelace', filledAt: expect.any(Date) },
      });
      // A checkbox stays a boolean in the evidence rather than flattening to a
      // string that a reader has to re-interpret.
      expect(prismaMock.requestField.update).toHaveBeenCalledWith({
        where: { id: 'rf-2' },
        data: { value: true, filledAt: expect.any(Date) },
      });
      expect(prismaMock.signatureEvent.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          metadata: expect.objectContaining({ fieldsCaptured: 2 }),
        }),
      });
    });
  });
});
