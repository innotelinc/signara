import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash, randomUUID } from 'node:crypto';
import { DocumentStatus, Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { MinioService } from '../../storage/minio.service';
import { MeilisearchService } from '../../storage/meilisearch.service';
import { AuthenticatedUser } from '../../common/types';

const ALLOWED_TYPES = new Map<string, string>([
  ['application/pdf', 'pdf'],
  ['application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'docx'],
  ['image/png', 'png'],
  ['image/jpeg', 'jpg'],
  ['image/webp', 'webp'],
]);

@Injectable()
export class DocumentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly minio: MinioService,
    private readonly meili: MeilisearchService,
    private readonly config: ConfigService,
  ) {}

  async upload(user: AuthenticatedUser, file: Express.Multer.File, data: { title?: string; workspaceId?: string; tags?: string[]; description?: string }) {
    const orgId = user.org?.id;
    if (!orgId) throw new ForbiddenException('No active tenant');

    const extension = ALLOWED_TYPES.get(file.mimetype);
    if (!extension) {
      throw new BadRequestException(`Unsupported file type: ${file.mimetype}. Allowed: PDF, DOCX, PNG, JPEG, WebP`);
    }
    if (file.size > 50 * 1024 * 1024) {
      throw new BadRequestException('File exceeds the 50 MB upload limit');
    }

    const sha256 = createHash('sha256').update(file.buffer).digest('hex');
    const key = `${orgId}/documents/${randomUUID()}.${extension}`;

    await this.minio.put(key, file.buffer, file.mimetype, sha256);

    const title = data.title ?? file.originalname.replace(/\.[^.]+$/, '') ?? 'Untitled document';
    const document = await this.prisma.document.create({
      data: {
        organizationId: orgId,
        workspaceId: data.workspaceId,
        title,
        description: data.description,
        fileName: file.originalname,
        fileKey: key,
        contentType: file.mimetype,
        sizeBytes: BigInt(file.size),
        checksumSha256: sha256,
        tags: data.tags ?? [],
        metadata: { uploadedVia: 'api' },
        createdById: user.id,
        versions: {
          create: {
            version: 1,
            fileKey: key,
            sizeBytes: BigInt(file.size),
            checksumSha256: sha256,
            createdById: user.id,
            changeNote: 'Initial upload',
          },
        },
      },
      include: { versions: { orderBy: { version: 'desc' }, take: 1 } },
    });

    void this.meili.indexDoc({
      id: document.id,
      organizationId: orgId,
      title: document.title,
      fileName: document.fileName,
      tags: document.tags,
      status: document.status,
      updatedAt: document.updatedAt.toISOString(),
    });

    return document;
  }

  async list(
    user: AuthenticatedUser,
    query: { status?: DocumentStatus; workspaceId?: string; search?: string; limit?: number; offset?: number },
  ) {
    const orgId = user.org?.id!;

    if (query.search) {
      const hits = await this.meili.search(orgId, query.search, query.limit ?? 20);
      const ids = hits.map((h) => h.id);
      if (ids.length === 0) return { total: 0, items: [] };
      const docs = await this.prisma.document.findMany({
        where: { id: { in: ids }, organizationId: orgId, deletedAt: null },
      });
      return { total: docs.length, items: docs };
    }

    const where: Prisma.DocumentWhereInput = {
      organizationId: orgId,
      deletedAt: null,
      ...(query.status ? { status: query.status } : {}),
      ...(query.workspaceId ? { workspaceId: query.workspaceId } : {}),
    };

    const [total, items] = await this.prisma.$transaction([
      this.prisma.document.count({ where }),
      this.prisma.document.findMany({
        where,
        orderBy: { updatedAt: 'desc' },
        skip: query.offset ?? 0,
        take: Math.min(query.limit ?? 25, 100),
        include: {
          signingRequests: { select: { id: true, status: true, mode: true } },
          _count: { select: { versions: true } },
        },
      }),
    ]);
    return { total, limit: Math.min(query.limit ?? 25, 100), offset: query.offset ?? 0, items };
  }

  async get(user: AuthenticatedUser, id: string) {
    const orgId = user.org?.id!;
    const document = await this.prisma.document.findFirst({
      where: { id, organizationId: orgId, deletedAt: null },
      include: {
        versions: { orderBy: { version: 'desc' } },
        signingRequests: { select: { id: true, status: true, mode: true, title: true, createdAt: true } },
      },
    });
    if (!document) throw new NotFoundException('Document not found');
    return document;
  }

  async download(user: AuthenticatedUser, id: string, version?: number) {
    const orgId = user.org?.id!;
    const document = await this.prisma.document.findFirst({ where: { id, organizationId: orgId } });
    if (!document) throw new NotFoundException('Document not found');

    let fileKey = document.fileKey;
    if (version) {
      const v = await this.prisma.documentVersion.findUnique({
        where: { documentId_version: { documentId: id, version } },
      });
      if (!v) throw new NotFoundException('Version not found');
      fileKey = v.fileKey;
    }

    const url = await this.minio.getPresignedUrl(fileKey, 900);
    return { url, fileName: document.fileName, contentType: document.contentType };
  }

  async updateMetadata(user: AuthenticatedUser, id: string, data: { title?: string; description?: string; tags?: string[]; workspaceId?: string }) {
    const orgId = user.org?.id!;
    const document = await this.prisma.document.findFirst({ where: { id, organizationId: orgId } });
    if (!document) throw new NotFoundException('Document not found');

    const updated = await this.prisma.document.update({
      where: { id },
      data: { title: data.title, description: data.description, tags: data.tags, workspaceId: data.workspaceId },
    });
    void this.meili.indexDoc({
      id: updated.id,
      organizationId: orgId,
      title: updated.title,
      fileName: updated.fileName,
      tags: updated.tags,
      status: updated.status,
      updatedAt: updated.updatedAt.toISOString(),
    });
    return updated;
  }

  /** Appends a new immutable version of the document. */
  async addVersion(user: AuthenticatedUser, id: string, file: Express.Multer.File, changeNote?: string) {
    const orgId = user.org?.id!;
    const document = await this.prisma.document.findFirst({ where: { id, organizationId: orgId } });
    if (!document) throw new NotFoundException('Document not found');

    const extension = ALLOWED_TYPES.get(file.mimetype);
    if (!extension) throw new BadRequestException('Unsupported file type');
    const sha256 = createHash('sha256').update(file.buffer).digest('hex');
    const key = `${orgId}/documents/${document.id}/v${document.version + 1}.${extension}`;
    await this.minio.put(key, file.buffer, file.mimetype, sha256);

    return this.prisma.$transaction(async (tx) => {
      const next = await tx.documentVersion.create({
        data: {
          documentId: id,
          version: document.version + 1,
          fileKey: key,
          sizeBytes: BigInt(file.size),
          checksumSha256: sha256,
          changeNote,
          createdById: user.id,
        },
      });
      const updated = await tx.document.update({
        where: { id },
        data: { version: { increment: 1 }, fileKey: key, fileName: file.originalname, sizeBytes: BigInt(file.size), checksumSha256: sha256 },
      });
      void this.meili.indexDoc({
        id: updated.id,
        organizationId: orgId,
        title: updated.title,
        fileName: updated.fileName,
        tags: updated.tags,
        status: updated.status,
        updatedAt: updated.updatedAt.toISOString(),
      });
      return { version: next, document: updated };
    });
  }

  /** Soft-deletes a document and removes it from the search index. */
  async softDelete(user: AuthenticatedUser, id: string) {
    const orgId = user.org?.id!;
    const document = await this.prisma.document.findFirst({ where: { id, organizationId: orgId } });
    if (!document) throw new NotFoundException('Document not found');

    await this.prisma.document.update({ where: { id }, data: { deletedAt: new Date() } });
    void this.meili.deleteDoc(id);
    return { success: true };
  }
}