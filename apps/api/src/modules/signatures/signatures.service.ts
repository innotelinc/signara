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
import {
  DocumentStatus,
  Prisma,
  SignatureEventType,
  SigningMode,
  SignerRole,
  SignerStatus,
  SignatureType,
} from '@prisma/client';
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
  workflowRules?: Array<{
    orderIndex: number;
    condition: Record<string, unknown>;
    action: 'APPROVE' | 'ROUTE' | 'REQUIRE' | 'NOTIFY';
    targetSignerId?: string;
  }>;
  sendInvites?: boolean;
}

interface ClientContext {
  ipAddress?: string;
  userAgent?: string;
  [key: string]: unknown;
}

/**
 * Fixed public token behind the landing page's "Try a demo signing room"
 * link (/sign/demo). The first request provisions an idempotent demo
 * session (its own org + document + signer) so the room works for anyone,
 * logged in or not, without a tenant or an account. Once the demo is
 * signed/expired the next visit resets it with a fresh document.
 */
const DEMO_TOKEN = 'demo';
const DEMO_ORG_SLUG = 'signara-demo';
const DEMO_DOC_TITLE = 'Signara Demo Agreement';
const DEMO_SIGNER_EMAIL = 'demo@signara.local';

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

    const document = await this.prisma.document.findFirst({
      where: { id: input.documentId, organizationId: orgId, deletedAt: null },
    });
    if (!document) throw new NotFoundException('Document not found');
    if (document.status === 'COMPLETED')
      throw new ConflictException('Document is already completed');

    if (!input.signers.length) throw new BadRequestException('At least one signer is required');
    if (input.signers.length > 50)
      throw new BadRequestException('A signing request supports at most 50 signers');
    const orderedSigners = input.signers
      .map((signer, index) => ({ ...signer, orderIndex: signer.orderIndex ?? index }))
      .sort((a, b) => a.orderIndex - b.orderIndex);
    const emails = new Set(orderedSigners.map((s) => s.email.toLowerCase().trim()));
    if (emails.size !== orderedSigners.length)
      throw new BadRequestException('Duplicate signer emails are not allowed');
    if (new Set(orderedSigners.map((s) => s.orderIndex)).size !== orderedSigners.length) {
      throw new BadRequestException('Signer orderIndex values must be unique');
    }

    // A new request creates its own signers, so arbitrary persisted signer IDs
    // cannot be valid workflow targets at this point.
    if (input.workflowRules?.some((rule) => rule.targetSignerId)) {
      throw new BadRequestException(
        'workflowRules.targetSignerId cannot be set while creating a new signing request',
      );
    }

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
          create: orderedSigners.map((s, index) => ({
            email: s.email.toLowerCase().trim(),
            name: s.name,
            role: s.role ?? SignerRole.SIGNER,
            orderIndex: s.orderIndex ?? index,
            status:
              mode === SigningMode.SEQUENTIAL && index > 0
                ? SignerStatus.PENDING
                : SignerStatus.INVITED,
            token: this.generateToken(),
          })),
        },
        workflowRules: input.workflowRules?.length
          ? {
              create: input.workflowRules.map((r) => ({
                orderIndex: r.orderIndex,
                condition: r.condition as object,
                action: r.action,
                targetSignerId: r.targetSignerId,
              })),
            }
          : undefined,
      },
      include: { signers: true, document: true },
    });

    await this.prisma.document.update({
      where: { id: document.id },
      data: { status: DocumentStatus.AWAITING_SIGNATURE },
    });
    await this.recordEvent(request.id, SignatureEventType.CREATED, null, { createdBy: user.email });

    const signingTrackers = request.signers.filter((s) => s.status === SignerStatus.INVITED);
    if (input.sendInvites !== false) {
      await this.enqueueInvites(
        request.id,
        signingTrackers.map((s) => s.id),
      );
    }

    return this.prisma.signingRequest.findUniqueOrThrow({
      where: { id: request.id },
      include: { signers: { orderBy: { orderIndex: 'asc' } }, document: true },
    });
  }

  // -------------------------------------------------------------- reads ----
  async listRequests(
    user: AuthenticatedUser,
    query: { status?: DocumentStatus; limit?: number; offset?: number },
  ) {
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
          signers: {
            select: {
              id: true,
              email: true,
              name: true,
              role: true,
              status: true,
              orderIndex: true,
            },
          },
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
    if (token === DEMO_TOKEN) {
      const current = await this.prisma.signer.findUnique({
        where: { token },
        include: { request: { select: { status: true } } },
      });
      const active =
        current &&
        ['AWAITING_SIGNATURE', 'IN_PROGRESS'].includes(current.request.status) &&
        current.status !== SignerStatus.DECLINED &&
        current.status !== SignerStatus.EXPIRED;
      if (!active) {
        await this.ensureDemoSession();
      }
    }

    const signer = await this.prisma.signer.findUnique({
      where: { token },
      include: {
        request: {
          include: {
            document: { select: { id: true, title: true, fileName: true, fileKey: true } },
          },
        },
      },
    });
    if (
      !signer ||
      !['AWAITING_SIGNATURE', 'IN_PROGRESS'].includes(signer.request.status) ||
      signer.status === SignerStatus.DECLINED ||
      signer.status === SignerStatus.EXPIRED
    ) {
      throw new NotFoundException('Signing session not found or no longer active');
    }
    if (signer.request.deadline && signer.request.deadline < new Date()) {
      await this.markRequestExpired(signer.requestId);
      throw new NotFoundException('Signing session has expired');
    }

    const canSignNow =
      (signer.status === SignerStatus.PENDING ||
        signer.status === SignerStatus.INVITED ||
        signer.status === SignerStatus.VIEWED) &&
      (await this.canSignerAct(signer));
    if (signer.status === SignerStatus.PENDING && canSignNow) {
      await this.prisma.signer.update({
        where: { id: signer.id },
        data: { status: SignerStatus.INVITED },
      });
      signer.status = SignerStatus.INVITED;
    }
    if (signer.status === SignerStatus.INVITED && canSignNow) {
      await this.prisma.signer.update({
        where: { id: signer.id },
        data: { status: SignerStatus.VIEWED, viewedAt: new Date() },
      });
      await this.recordEvent(signer.requestId, SignatureEventType.VIEWED, signer.id, ctx);
      signer.status = SignerStatus.VIEWED;
    }

    const downloadUrl = await this.minio.getPresignedUrl(signer.request.document.fileKey, 3600);
    return {
      requestId: signer.requestId,
      title: signer.request.title ?? signer.request.document.title,
      document: {
        id: signer.request.document.id,
        fileName: signer.request.document.fileName,
        downloadUrl,
      },
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
      allowsSigning: canSignNow,

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
    const signer = await this.prisma.signer.findUnique({
      where: { token },
      include: { request: true },
    });
    if (!signer) throw new NotFoundException('Signing session not found');
    if (!['AWAITING_SIGNATURE', 'IN_PROGRESS'].includes(signer.request.status)) {
      throw new ConflictException('This signing request is no longer active');
    }
    if (signer.request.deadline && signer.request.deadline < new Date()) {
      await this.markRequestExpired(signer.requestId);
      throw new ConflictException('This signing request has expired');
    }
    if (signer.role === SignerRole.CC)
      throw new BadRequestException('Carbon-copy recipients cannot sign');
    if (signer.status === SignerStatus.SIGNED) throw new ConflictException('Already signed');
    if (signer.status === SignerStatus.DECLINED)
      throw new ConflictException('Signing session was declined');
    if (
      (signer.status !== SignerStatus.INVITED && signer.status !== SignerStatus.VIEWED) ||
      !(await this.canSignerAct(signer))
    ) {
      throw new ConflictException('Not your turn — this request is in sequential order');
    }

    const document = await this.prisma.document.findUniqueOrThrow({
      where: { id: signer.request.documentId },
    });
    const contentHash = await this.computeContentHash(
      document.fileKey,
      signer.email,
      signer.requestId,
    );
    if (input.signedHash && input.signedHash !== contentHash) {
      throw new BadRequestException('signedHash does not match the current document contents');
    }
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
      throw new BadRequestException(
        'signatureValue requires certificateId (certificate-backed signing)',
      );
    }

    let signature: {
      id: string;
      type: SignatureType;
      certificateSerial: string | null;
      certificateId: string | null;
    };
    try {
      signature = await this.prisma.signature.create({
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
          cryptoAlgorithm:
            input.cryptoAlgorithm ?? certificateEvidence?.cryptoAlgorithm ?? 'SHA-256',
          identityAssurance: certificateEvidence
            ? (certificateEvidence.identityAssurance as unknown as Prisma.InputJsonValue)
            : (unsignedAssurance(
                false,
                Boolean(signer.userId),
              ) as unknown as Prisma.InputJsonValue),
          ipAddress: ctx.ipAddress,
          userAgent: ctx.userAgent,
        },
      });
    } catch (error) {
      if ((error as { code?: string }).code === 'P2002') {
        throw new ConflictException('Already signed');
      }
      throw error;
    }

    await this.prisma.signer.update({
      where: { id: signer.id },
      data: {
        status: SignerStatus.SIGNED,
        signedAt: new Date(),
        authMethod: certificateEvidence ? 'certificate' : signer.authMethod,
      },
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
    return {
      success: true,
      signatureId: signature.id,
      identityAssurance: certificateEvidence?.identityAssurance,
    };
  }

  async decline(token: string, reason?: string, ctx?: ClientContext) {
    const signer = await this.prisma.signer.findUnique({
      where: { token },
      include: { request: true },
    });
    if (!signer) throw new NotFoundException('Signing session not found');
    if (!['AWAITING_SIGNATURE', 'IN_PROGRESS'].includes(signer.request.status)) {
      throw new ConflictException('This signing request is no longer active');
    }
    if (signer.request.deadline && signer.request.deadline < new Date()) {
      await this.markRequestExpired(signer.requestId);
      throw new ConflictException('This signing request has expired');
    }
    if (signer.role === SignerRole.CC)
      throw new BadRequestException('Carbon-copy recipients cannot decline');
    if (signer.status === SignerStatus.SIGNED) throw new ConflictException('Already signed');
    if (signer.status === SignerStatus.DECLINED)
      throw new ConflictException('Signing session was declined');
    if (
      signer.status &&
      signer.status !== SignerStatus.INVITED &&
      signer.status !== SignerStatus.VIEWED
    ) {
      throw new ConflictException('Signing session is not ready for a response');
    }
    if (!(await this.canSignerAct(signer))) {
      throw new ConflictException('Not your turn — this request is in sequential order');
    }

    await this.prisma.signer.update({
      where: { id: signer.id },
      data: { status: SignerStatus.DECLINED },
    });
    await this.recordEvent(signer.requestId, SignatureEventType.DECLINED, signer.id, {
      ...ctx,
      reason,
    });

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
    const signer = await this.prisma.signer.findUnique({
      where: { token },
      include: { request: { select: { status: true } } },
    });
    if (!signer || !['AWAITING_SIGNATURE', 'IN_PROGRESS'].includes(signer.request.status)) {
      throw new NotFoundException('Session not found');
    }
    const events = await this.prisma.signatureEvent.findMany({
      where: { requestId: signer.requestId },
      orderBy: { createdAt: 'asc' },
      select: { id: true, type: true, createdAt: true, metadata: true },
    });
    return {
      requestId: signer.requestId,
      signerId: signer.id,
      events: events.map((event) => ({
        ...event,
        metadata: this.publicEventMetadata(event.type, event.metadata),
      })),
    };
  }

  // ------------------------------------------------------------ control ----
  async cancel(user: AuthenticatedUser, id: string, reason?: string) {
    const orgId = user.org?.id!;
    const request = await this.prisma.signingRequest.findFirst({
      where: { id, organizationId: orgId },
    });
    if (!request) throw new NotFoundException('Signing request not found');
    if (request.status === 'COMPLETED')
      throw new ConflictException('Cannot cancel a completed request');

    await this.prisma.signingRequest.update({
      where: { id },
      data: { status: DocumentStatus.CANCELLED },
    });
    await this.prisma.document.update({
      where: { id: request.documentId },
      data: { status: DocumentStatus.CANCELLED },
    });
    await this.recordEvent(id, SignatureEventType.CANCELLED, null, {
      reason,
      cancelledBy: user.email,
    });
    return { success: true };
  }

  async remind(
    user: AuthenticatedUser,
    id: string,
    signerId?: string,
  ): Promise<{ success: boolean; enqueued: number }> {
    const orgId = user.org?.id!;
    const request = await this.prisma.signingRequest.findFirst({
      where: { id, organizationId: orgId },
    });
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
      where: {
        requestId: id,
        type: SignatureEventType.REMINDED,
        createdAt: { gt: reminderWindow },
      },
    });
    const recentlyReminded = new Set(reminderEvents.map((e) => e.signerId).filter(Boolean));

    const targets = signers.filter((s) => !recentlyReminded.has(s.id));
    for (const signer of targets) {
      await this.signingQueue.add(
        'send-signing-reminder',
        { requestId: id, signerId: signer.id, attempt: signer.reminderCount + 1 },
        { delay: 0 },
      );
      await this.prisma.signer.update({
        where: { id: signer.id },
        data: { reminderCount: { increment: 1 } },
      });
      await this.recordEvent(id, SignatureEventType.REMINDED, signer.id, {
        requestedBy: user.email,
      });
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

  /** Creates (or resets) the always-on demo signing session behind /sign/demo. */
  private async ensureDemoSession(): Promise<void> {
    const org = await this.prisma.organization.upsert({
      where: { slug: DEMO_ORG_SLUG },
      update: { status: 'ACTIVE' },
      create: { name: 'Signara Demo', slug: DEMO_ORG_SLUG, status: 'ACTIVE' },
    });

    // Remove any previous demo artifacts (a completed demo resets on next
    // visit). Deleting the document cascades its requests, signers, events.
    await this.prisma.signer.deleteMany({ where: { token: DEMO_TOKEN } });
    await this.prisma.document.deleteMany({
      where: { organizationId: org.id, title: DEMO_DOC_TITLE },
    });

    const pdf = this.demoPdf();
    const checksum = createHash('sha256').update(pdf).digest('hex');
    const fileKey = `${org.id}/documents/signara-demo-agreement.pdf`;
    await this.minio.put(fileKey, pdf, 'application/pdf', checksum);

    const document = await this.prisma.document.create({
      data: {
        organizationId: org.id,
        title: DEMO_DOC_TITLE,
        description: 'A sample agreement used by the Signara demo signing room.',
        fileName: 'signara-demo-agreement.pdf',
        fileKey,
        contentType: 'application/pdf',
        sizeBytes: pdf.length,
        checksumSha256: checksum,
        status: DocumentStatus.DRAFT,
      },
    });

    const request = await this.prisma.signingRequest.create({
      data: {
        organizationId: org.id,
        documentId: document.id,
        title: 'Signara Demo Agreement',
        message:
          'This is a self-serve demo. Sign it to see how Signara records the signature, timestamps it, and keeps an audit trail.',
        status: DocumentStatus.AWAITING_SIGNATURE,
        mode: SigningMode.PARALLEL,
      },
    });

    await this.prisma.signer.create({
      data: {
        requestId: request.id,
        email: DEMO_SIGNER_EMAIL,
        name: 'Demo Signer',
        role: SignerRole.SIGNER,
        orderIndex: 0,
        status: SignerStatus.INVITED,
        token: DEMO_TOKEN,
        authMethod: 'email',
      },
    });
    await this.recordEvent(request.id, SignatureEventType.CREATED, null, {
      createdBy: 'demo',
    });
  }

  /** A tiny but valid single-page PDF describing the demo. */
  private demoPdf(): Buffer {
    const objects: Record<number, string> = {
      1: '<< /Type /Catalog /Pages 2 0 R >>',
      2: '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
      3: '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
      5: '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    };
    const stream =
      'BT /F1 18 Tf 72 730 Td (Signara Demo Agreement) Tj ET\n' +
      'BT /F1 11 Tf 72 700 Td (This is a sample agreement for the Signara demo signing room.) Tj ET\n' +
      'BT /F1 11 Tf 72 684 Td (Sign it to see how an electronic signature is recorded with a full audit trail.) Tj ET\n';
    objects[4] = `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}endstream`;

    let out = '%PDF-1.4\n';
    const offsets: number[] = [];
    for (let i = 1; i <= 5; i++) {
      offsets[i] = Buffer.byteLength(out);
      out += `${i} 0 obj\n${objects[i]}\nendobj\n`;
    }
    const xrefPos = Buffer.byteLength(out);
    out += 'xref\n0 6\n0000000000 65535 f \n';
    for (let i = 1; i <= 5; i++) {
      out += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
    }
    out += `trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xrefPos}\n%%EOF\n`;
    return Buffer.from(out, 'utf8');
  }

  // ------------------------------------------------------------ helpers ----
  private canSignNow(
    mode: SigningMode,
    signer: { role: SignerRole; orderIndex: number; status: SignerStatus },
  ): boolean {
    if (signer.role === SignerRole.APPROVER) return true;
    if (mode === SigningMode.PARALLEL) return true;
    return signer.status === SignerStatus.INVITED || signer.status === SignerStatus.VIEWED;
  }

  /** Checks the current request state so a sequential token cannot skip ahead. */
  private async canSignerAct(signer: {
    id: string;
    requestId: string;
    role: SignerRole;
    orderIndex: number;
    status: SignerStatus;
    request: { mode: SigningMode; status?: DocumentStatus };
  }): Promise<boolean> {
    if (signer.role === SignerRole.CC) return false;
    if (signer.request.mode === SigningMode.PARALLEL) return true;
    const earlier =
      (await this.prisma.signer.findMany({
        where: {
          requestId: signer.requestId,
          orderIndex: { lt: signer.orderIndex },
          role: { not: SignerRole.CC },
        },
        select: { status: true },
      })) ?? [];
    return earlier.every((candidate) => candidate.status === SignerStatus.SIGNED);
  }

  /** Advances the workflow after a signature event. */
  private async advanceWorkflow(requestId: string, mode: SigningMode): Promise<void> {
    const request = await this.prisma.signingRequest.findUnique({
      where: { id: requestId },
      include: { signers: { orderBy: { orderIndex: 'asc' } } },
    });
    if (!request) return;

    const signers = request.signers;
    const allSigned = signers.every(
      (s) => s.role === SignerRole.CC || s.status === SignerStatus.SIGNED,
    );

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
      const next = signers.find(
        (s) => s.role !== SignerRole.CC && s.status === SignerStatus.PENDING,
      );
      if (next) {
        await this.prisma.signer.update({
          where: { id: next.id },
          data: { status: SignerStatus.INVITED },
        });
        await this.enqueueInvites(requestId, [next.id]);
      }
    }
  }

  private async markRequestExpired(requestId: string): Promise<void> {
    await this.prisma.signingRequest.update({
      where: { id: requestId },
      data: { status: DocumentStatus.EXPIRED },
    });
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
        userAgent:
          typeof metadata.userAgent === 'string' ? metadata.userAgent?.slice(0, 500) : undefined,
      },
    });
  }

  private generateToken(): string {
    return `sgn_${randomBytes(24).toString('base64url')}`;
  }

  private async computeContentHash(
    fileKey: string,
    signerEmail: string,
    requestId: string,
  ): Promise<string> {
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
      await this.signingQueue.add(
        'send-signing-invite',
        { requestId, signerId },
        { delay: 0, attempts: 5 },
      );
    }
  }

  private publicEventMetadata(
    type: string,
    metadata: Prisma.JsonValue | null,
  ): Record<string, boolean> | null {
    if (
      type !== SignatureEventType.SIGNED ||
      !metadata ||
      typeof metadata !== 'object' ||
      Array.isArray(metadata)
    ) {
      return null;
    }
    return { completed: (metadata as Record<string, unknown>).completed === true };
  }

  private buildComplianceStatement(events: Array<{ type: string; createdAt: Date }>): string {
    const signedCount = events.filter((e) => e.type === 'SIGNED').length;
    return `This document was processed through Signara's signing workflow. ${signedCount} signature event(s) were recorded with timestamped, audit-trail evidence. See eIDAS Article 25 and ESIGN (15 U.S.C. § 7001) for legal acceptance of electronic signatures.`;
  }
}
