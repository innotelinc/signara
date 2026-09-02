import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { DocumentStatus, Prisma, SignatureEventType, SigningMode, SignerRole, SignerStatus, SignatureType } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { MinioService } from '../../storage/minio.service';
import { CertificatesService, CertificateEvidence } from '../certificates/certificates.service';
import { unsignedAssurance } from '../certificates/identity-assurance';
import { AuthenticatedUser } from '../../common/types';

export interface CreateRequestInput {
  documentId: string;
  title?: string;
  message?: string;
  deadline?: Date;
  mode?: SigningMode;
  signers: Array<{
    email: string;
    name?: string;
    role?: SignerRole;
    orderIndex?: number;
  }>;
  workflowRules?: Array<{ orderIndex: number; condition: Record<string, unknown>; action: 'APPROVE' | 'ROUTE' | 'REQUIRE' | 'NOTIFY'; targetSignerId?: string }>;
  sendInvites?: boolean;
}

interface ClientContext {
  ipAddress?: string;
  userAgent?: string;
  [key: string]: unknown;
}

@Injectable()
export class SignaturesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly minio: MinioService,
    private readonly certificates: CertificatesService,
    @InjectQueue('signing') private readonly signingQueue: Queue,
  ) {}

  // ------------------------------------------------------------ create ----
  async createRequest(user: AuthenticatedUser, input: CreateRequestInput) {
    const orgId = user.org?.id;
    if (!orgId) throw new ForbiddenException('No active tenant');

    const document = await this.prisma.document.findFirst({ where: { id: input.documentId, organizationId: orgId, deletedAt: null } });
    if (!document) throw new NotFoundException('Document not found');
    if (document.status === 'COMPLETED') throw new ConflictException('Document is already completed');

    if (!input.signers.length) throw new BadRequestException('At least one signer is required');
    if (input.signers.length > 50) throw new BadRequestException('A signing request supports at most 50 signers');
    const emails = new Set(input.signers.map((s) => s.email.toLowerCase()));
    if (emails.size !== input.signers.length) throw new BadRequestException('Duplicate signer emails are not allowed');

    // Sequential mode: only the first (or next) signer may act at a time.
    const mode = input.mode ?? SigningMode.SEQUENTIAL;

    const request = await this.prisma.signingRequest.create({
      data: {
        organizationId: orgId,
        documentId: document.id,
        title: input.title ?? document.title,
        message: input.message,
        deadline: input.deadline,
        mode,
        status: DocumentStatus.AWAITING_SIGNATURE,
        createdById: user.id,
        signers: {
          create: input.signers.map((s, index) => ({
            email: s.email.toLowerCase(),
            name: s.name,
            role: s.role ?? SignerRole.SIGNER,
            orderIndex: s.orderIndex ?? index,
            status:
              mode === SigningMode.SEQUENTIAL && index > 0 ? SignerStatus.PENDING : SignerStatus.INVITED,
            token: this.generateToken(),
          })),
        },
        workflowRules: input.workflowRules?.length
          ? { create: input.workflowRules.map((r) => ({ orderIndex: r.orderIndex, condition: r.condition as object, action: r.action, targetSignerId: r.targetSignerId })) }
          : undefined,
      },
      include: { signers: true, document: true },
    });

    await this.prisma.document.update({ where: { id: document.id }, data: { status: DocumentStatus.AWAITING_SIGNATURE } });
    await this.recordEvent(request.id, SignatureEventType.CREATED, null, { createdBy: user.email });

    const signingTrackers = request.signers.filter((s) => s.status === SignerStatus.INVITED);
    if (input.sendInvites !== false) {
      await this.enqueueInvites(request.id, signingTrackers.map((s) => s.id));
    }

    return this.prisma.signingRequest.findUniqueOrThrow({
      where: { id: request.id },
      include: { signers: { orderBy: { orderIndex: 'asc' } }, document: true },
    });
  }

  // -------------------------------------------------------------- reads ----
  async listRequests(user: AuthenticatedUser, query: { status?: DocumentStatus; limit?: number; offset?: number }) {
    const orgId = user.org?.id!;
    const where = {
      organizationId: orgId,
      ...(query.status ? { status: query.status } : {}),
    };
    const [total, items] = await this.prisma.$transaction([
      this.prisma.signingRequest.count({ where }),
      this.prisma.signingRequest.findMany({
        where,
        include: {
          document: { select: { id: true, title: true, fileName: true } },
          signers: { select: { id: true, email: true, name: true, role: true, status: true, orderIndex: true } },
        },
        orderBy: { updatedAt: 'desc' },
        skip: query.offset ?? 0,
        take: Math.min(query.limit ?? 25, 100),
      }),
    ]);
    return { total, items };
  }

  async getRequest(user: AuthenticatedUser, id: string) {
    const orgId = user.org?.id!;
    const request = await this.prisma.signingRequest.findFirst({
      where: { id, organizationId: orgId },
      include: {
        document: { select: { id: true, title: true, fileName: true, fileKey: true } },
        signers: { orderBy: { orderIndex: 'asc' } },
        events: { orderBy: { createdAt: 'asc' } },
        signatures: true,
        workflowRules: { orderBy: { orderIndex: 'asc' } },
      },
    });
    if (!request) throw new NotFoundException('Signing request not found');
    return request;
  }

  // -------------------------------------------------------- public flow ---
  /**
   * Public signing session accessed via unguessable per-signer token.
   * No authentication is required by design; the token IS the credential.
   * The response only contains what that signer may see.
   */
  async publicSession(token: string, ctx: ClientContext) {
    const signer = await this.prisma.signer.findUnique({
      where: { token },
      include: { request: { include: { document: { select: { id: true, title: true, fileName: true, fileKey: true } } } } },
    });
    if (!signer || signer.request.status === 'CANCELLED' || signer.request.status === 'VOIDED') {
      throw new NotFoundException('Signing session not found or no longer active');
    }
    if (signer.request.deadline && signer.request.deadline < new Date()) {
      await this.markRequestExpired(signer.requestId);
      throw new NotFoundException('Signing session has expired');
    }

    if (signer.status === SignerStatus.PENDING) {
      await this.prisma.signer.update({ where: { id: signer.id }, data: { status: SignerStatus.INVITED } });
    }
    if (signer.status !== SignerStatus.VIEWED) {
      await this.prisma.signer.update({ where: { id: signer.id }, data: { viewedAt: new Date() } });
      await this.recordEvent(signer.requestId, SignatureEventType.VIEWED, signer.id, ctx);
    }

    const downloadUrl = await this.minio.getPresignedUrl(signer.request.document.fileKey, 3600);
    return {
      requestId: signer.requestId,
      title: signer.request.title ?? signer.request.document.title,
      document: { id: signer.request.document.id, fileName: signer.request.document.fileName, downloadUrl },
      signer: {
        id: signer.id,
        email: signer.email,
        name: signer.name,
        role: signer.role,
        status: signer.status,
        orderIndex: signer.orderIndex,
      },
      message: signer.request.message,
      deadline: signer.request.deadline,
      mode: signer.request.mode,
      allowsSigning: this.canSignNow(signer.request.mode, signer),
      authMethod: signer.role === SignerRole.SIGNER ? (signer.userId ? 'oidc' : 'email') : 'email',
      requestedFields: await this.fieldsForDocument(signer.request.documentId),
    };
  }

  /** Records the signature and advances the workflow. */
  async sign(
    token: string,
    input: {
      type?: SignatureType;
      certificateSerial?: string;
      signedHash?: string;
      cryptoAlgorithm?: string;
      signatureData?: string;
      certificateId?: string;
      signatureValue?: string;
    },
    ctx: ClientContext,
  ) {
    const signer = await this.prisma.signer.findUnique({ where: { token }, include: { request: true } });
    if (!signer) throw new NotFoundException('Signing session not found');
    if (signer.role === SignerRole.CC) throw new BadRequestException('Carbon-copy recipients cannot sign');
    if (signer.status === SignerStatus.SIGNED) throw new ConflictException('Already signed');
    if (signer.status === SignerStatus.DECLINED) throw new ConflictException('Signing session was declined');
    if (!this.canSignNow(signer.request.mode, signer)) {
      throw new ConflictException('Not your turn — this request is in sequential order');
    }

    const document = await this.prisma.document.findUniqueOrThrow({ where: { id: signer.request.documentId } });
    const contentHash = await this.computeContentHash(document.fileKey, signer.email, signer.requestId);
    const finalHash = input.signedHash ?? contentHash;

    // Certificate-backed signing: bind the certificate to the signer identity,
    // produce/verify the cryptographic signature, and snapshot the assurance.
    let certificateEvidence: CertificateEvidence | undefined;
    if (input.type === SignatureType.CERTIFICATE || input.certificateId) {
      if (!input.certificateId) {
        throw new BadRequestException('certificateId is required for certificate signatures');
      }
      certificateEvidence = await this.certificates.signWithCertificate({
        organizationId: signer.request.organizationId,
        certificateId: input.certificateId,
        signerUserId: signer.userId,
        signerEmail: signer.email,
        contentHash: finalHash,
        providedSignature: input.signatureValue,
      });
    } else if (input.signatureValue) {
      throw new BadRequestException('signatureValue requires certificateId (certificate-backed signing)');
    }

    const signature = await this.prisma.signature.create({
      data: {
        requestId: signer.requestId,
        documentId: signer.request.documentId,
        signerId: signer.id,
        type: input.type ?? SignatureType.TYPED,
        certificateId: certificateEvidence?.certificateId ?? null,
        certificateSerial: input.certificateSerial ?? certificateEvidence?.serialNumber ?? null,
        signedHash: finalHash,
        signatureValue: certificateEvidence?.signatureValue ?? null,
        signatureFormat: certificateEvidence?.signatureFormat ?? null,
        cryptoAlgorithm: input.cryptoAlgorithm ?? certificateEvidence?.cryptoAlgorithm ?? 'SHA-256',
        identityAssurance: certificateEvidence
          ? (certificateEvidence.identityAssurance as unknown as Prisma.InputJsonValue)
          : (unsignedAssurance(false, Boolean(signer.userId)) as unknown as Prisma.InputJsonValue),
        ipAddress: ctx.ipAddress,
        userAgent: ctx.userAgent,
      },
    });

    await this.prisma.signer.update({
      where: { id: signer.id },
      data: { status: SignerStatus.SIGNED, signedAt: new Date(), authMethod: certificateEvidence ? 'certificate' : signer.authMethod },
    });
    await this.recordEvent(signer.requestId, SignatureEventType.SIGNED, signer.id, {
      ...ctx,
      signatureId: signature.id,
      type: signature.type,
      certificateSerial: signature.certificateSerial,
      certificateId: signature.certificateId,
      identityAssurance: certificateEvidence?.identityAssurance,
    });

    await this.advanceWorkflow(signer.requestId, signer.request.mode);
    return { success: true, signatureId: signature.id, identityAssurance: certificateEvidence?.identityAssurance };
  }

  async decline(token: string, reason?: string, ctx?: ClientContext) {
    const signer = await this.prisma.signer.findUnique({ where: { token }, include: { request: true } });
    if (!signer) throw new NotFoundException('Signing session not found');
    if (signer.status === SignerStatus.SIGNED) throw new ConflictException('Already signed');

    await this.prisma.signer.update({ where: { id: signer.id }, data: { status: SignerStatus.DECLINED } });
    await this.recordEvent(signer.requestId, SignatureEventType.DECLINED, signer.id, { ...ctx, reason });

    // In sequential mode the next signer never gets activated once someone declines.
    if (signer.request.mode === SigningMode.SEQUENTIAL) {
      await this.prisma.signingRequest.update({
        where: { id: signer.requestId },
        data: { status: DocumentStatus.IN_PROGRESS },
      });
    }
    return { success: true };
  }

  /** Signer-scoped event history (used by the signer UI + evidence display). */
  async publicEvents(token: string) {
    const signer = await this.prisma.signer.findUnique({ where: { token } });
    if (!signer) throw new NotFoundException('Session not found');
    const events = await this.prisma.signatureEvent.findMany({
      where: { requestId: signer.requestId },
      orderBy: { createdAt: 'asc' },
      select: { id: true, type: true, createdAt: true, metadata: true },
    });
    return { requestId: signer.requestId, signerId: signer.id, events };
  }

  // ------------------------------------------------------------ control ----
  async cancel(user: AuthenticatedUser, id: string, reason?: string) {
    const orgId = user.org?.id!;
    const request = await this.prisma.signingRequest.findFirst({ where: { id, organizationId: orgId } });
    if (!request) throw new NotFoundException('Signing request not found');
    if (request.status === 'COMPLETED') throw new ConflictException('Cannot cancel a completed request');

    await this.prisma.signingRequest.update({ where: { id }, data: { status: DocumentStatus.CANCELLED } });
    await this.prisma.document.update({ where: { id: request.documentId }, data: { status: DocumentStatus.CANCELLED } });
    await this.recordEvent(id, SignatureEventType.CANCELLED, null, { reason, cancelledBy: user.email });
    return { success: true };
  }

  async remind(user: AuthenticatedUser, id: string, signerId?: string): Promise<{ success: boolean; enqueued: number }> {
    const orgId = user.org?.id!;
    const request = await this.prisma.signingRequest.findFirst({ where: { id, organizationId: orgId } });
    if (!request) throw new NotFoundException('Signing request not found');

    const signers = await this.prisma.signer.findMany({
      where: {
        requestId: id,
        ...(signerId ? { id: signerId } : {}),
        status: { in: [SignerStatus.INVITED, SignerStatus.VIEWED] },
      },
    });

    // Throttle: max one reminder per signer per 24h
    const reminderWindow = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const reminderEvents = await this.prisma.signatureEvent.findMany({
      where: { requestId: id, type: SignatureEventType.REMINDED, createdAt: { gt: reminderWindow } },
    });
    const recentlyReminded = new Set(reminderEvents.map((e) => e.signerId).filter(Boolean));

    const targets = signers.filter((s) => !recentlyReminded.has(s.id));
    for (const signer of targets) {
      await this.signingQueue.add(
        'send-signing-reminder',
        { requestId: id, signerId: signer.id, attempt: signer.reminderCount + 1 },
        { delay: 0 },
      );
      await this.prisma.signer.update({ where: { id: signer.id }, data: { reminderCount: { increment: 1 } } });
      await this.recordEvent(id, SignatureEventType.REMINDED, signer.id, { requestedBy: user.email });
    }

    return { success: true, enqueued: targets.length };
  }

  /** Certificate / audit evidence report for a request. */
  async evidenceReport(user: AuthenticatedUser, id: string) {
    const orgId = user.org?.id!;
    const request = await this.prisma.signingRequest.findFirst({
      where: { id, organizationId: orgId },
      include: {
        document: { select: { id: true, title: true, fileName: true, checksumSha256: true } },
        signers: { include: { signatures: true } },
        events: { orderBy: { createdAt: 'asc' } },
        signatures: true,
      },
    });
    if (!request) throw new NotFoundException('Signing request not found');

    return {
      reportId: randomUUID(),
      generatedAt: new Date().toISOString(),
      requestId: request.id,
      document: request.document,
      mode: request.mode,
      status: request.status,
      envelope: {
        signers: request.signers.map((s) => ({
          email: s.email,
          name: s.name,
          role: s.role,
          status: s.status,
          signedAt: s.signedAt,
          authMethod: s.authMethod,
          signatures: s.signatures.map((sig) => ({
            id: sig.id,
            type: sig.type,
            certificateId: sig.certificateId,
            certificateSerial: sig.certificateSerial,
            signedHash: sig.signedHash,
            signatureValue: sig.signatureValue,
            signatureFormat: sig.signatureFormat,
            cryptoAlgorithm: sig.cryptoAlgorithm,
            identityAssurance: sig.identityAssurance,
            ipAddress: sig.ipAddress,
            signedAt: sig.signedAt,
          })),
        })),
      },
      auditTrail: request.events.map((e) => ({
        type: e.type,
        at: e.createdAt,
        signerId: e.signerId,
        metadata: e.metadata,
        ipAddress: e.ipAddress,
        userAgent: e.userAgent,
      })),
      statement: this.buildComplianceStatement(request.events),
    };
  }

  // ------------------------------------------------------------ helpers ----
  private canSignNow(mode: SigningMode, signer: { role: SignerRole; orderIndex: number; status: SignerStatus }): boolean {
    if (signer.role === SignerRole.APPROVER) return true;
    if (mode === SigningMode.PARALLEL) return true;
    return signer.orderIndex === 0 || signer.status === SignerStatus.INVITED || signer.status === SignerStatus.VIEWED;
  }

  /** Advances the workflow after a signature event. */
  private async advanceWorkflow(requestId: string, mode: SigningMode): Promise<void> {
    const request = await this.prisma.signingRequest.findUnique({
      where: { id: requestId },
      include: { signers: { orderBy: { orderIndex: 'asc' } } },
    });
    if (!request) return;

    const signers = request.signers;
    const allSigned = signers.every((s) => s.role === SignerRole.CC || s.status === SignerStatus.SIGNED);

    if (allSigned) {
      await this.prisma.signingRequest.update({
        where: { id: requestId },
        data: { status: DocumentStatus.COMPLETED, completedAt: new Date() },
      });
      await this.prisma.document.update({
        where: { id: request.documentId },
        data: { status: DocumentStatus.COMPLETED },
      });
      await this.recordEvent(requestId, SignatureEventType.SIGNED, null, { completed: true });
      return;
    }

    if (mode === SigningMode.SEQUENTIAL) {
      // Reveal the next unsigned signer
      const next = signers.find((s) => s.role !== SignerRole.CC && s.status === SignerStatus.PENDING);
      if (next) {
        await this.prisma.signer.update({ where: { id: next.id }, data: { status: SignerStatus.INVITED } });
        await this.enqueueInvites(requestId, [next.id]);
      }
    }
  }

  private async markRequestExpired(requestId: string): Promise<void> {
    await this.prisma.signingRequest.update({ where: { id: requestId }, data: { status: DocumentStatus.EXPIRED } });
    await this.recordEvent(requestId, SignatureEventType.EXPIRED, null, {});
  }

  private async recordEvent(
    requestId: string,
    type: SignatureEventType,
    signerId: string | null,
    metadata: Record<string, unknown>,
  ): Promise<void> {
    await this.prisma.signatureEvent.create({
      data: {
        requestId,
        signerId,
        type,
        metadata: metadata as object,
        ipAddress: typeof metadata.ipAddress === 'string' ? metadata.ipAddress : undefined,
        userAgent: typeof metadata.userAgent === 'string' ? metadata.userAgent?.slice(0, 500) : undefined,
      },
    });
  }

  private generateToken(): string {
    return `sgn_${randomBytes(24).toString('base64url')}`;
  }

  private async computeContentHash(fileKey: string, signerEmail: string, requestId: string): Promise<string> {
    const buffer = await this.minio.getBuffer(fileKey);
    return createHash('sha256')
      .update(buffer)
      .update(`|signer=${signerEmail}|request=${requestId}|`)
      .digest('hex');
  }

  private async fieldsForDocument(documentId: string) {
    // Placeholder: field positions come from template definitions; when signing
    // from a template, fields are hydrated here. See docs/Architecture.md.
    return [];
  }

  private async enqueueInvites(requestId: string, signerIds: string[]): Promise<void> {
    for (const signerId of signerIds) {
      await this.signingQueue.add('send-signing-invite', { requestId, signerId }, { delay: 0, attempts: 5 });
    }
  }

  private buildComplianceStatement(events: Array<{ type: string; createdAt: Date }>): string {
    const signedCount = events.filter((e) => e.type === 'SIGNED').length;
    return `This document was processed through Signara's signing workflow. ${signedCount} signature event(s) were recorded with timestamped, audit-trail evidence. See eIDAS Article 25 and ESIGN (15 U.S.C. § 7001) for legal acceptance of electronic signatures.`;
  }
}