import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { FieldType, Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { AuthenticatedUser } from '../../common/types';

export interface TemplateFieldInput {
  type: FieldType;
  name?: string;
  key?: string;
  isRequired?: boolean;
  pageNumber?: number;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  options?: unknown;
}

const MAX_FIELDS_PER_TEMPLATE = 200;

@Injectable()
export class TemplatesService {
  constructor(private readonly prisma: PrismaService) {}

  async create(
    user: AuthenticatedUser,
    data: { name: string; description?: string; workspaceId?: string; variables?: Record<string, string>; fields?: TemplateFieldInput[] },
  ) {
    const orgId = user.org?.id;
    if (!orgId) throw new ForbiddenException('No active tenant');

    if ((data.fields?.length ?? 0) > MAX_FIELDS_PER_TEMPLATE) {
      throw new Error(`A template may define at most ${MAX_FIELDS_PER_TEMPLATE} fields`);
    }

    return this.prisma.template.create({
      data: {
        organizationId: orgId,
        workspaceId: data.workspaceId,
        name: data.name,
        description: data.description,
        variables: data.variables as object,
        createdById: user.id,
        fields: data.fields
          ? { create: data.fields.map((f) => this.toFieldCreate(f)) }
          : undefined,
      },
      include: { fields: true },
    });
  }

  async list(user: AuthenticatedUser, query: { status?: 'DRAFT' | 'ACTIVE' | 'ARCHIVED'; workspaceId?: string; limit?: number; offset?: number }) {
    const orgId = user.org?.id!;
    const where: Prisma.TemplateWhereInput = {
      organizationId: orgId,
      ...(query.status ? { status: query.status } : {}),
      ...(query.workspaceId ? { workspaceId: query.workspaceId } : {}),
    };
    const [total, items] = await this.prisma.$transaction([
      this.prisma.template.count({ where }),
      this.prisma.template.findMany({
        where,
        include: { _count: { select: { fields: true, documents: true } } },
        orderBy: { updatedAt: 'desc' },
        skip: query.offset ?? 0,
        take: Math.min(query.limit ?? 25, 100),
      }),
    ]);
    return { total, items };
  }

  async get(user: AuthenticatedUser, id: string) {
    const orgId = user.org?.id!;
    const template = await this.prisma.template.findFirst({
      where: { id, organizationId: orgId },
      include: { fields: { orderBy: { pageNumber: 'asc' } } },
    });
    if (!template) throw new NotFoundException('Template not found');
    return template;
  }

  async update(
    user: AuthenticatedUser,
    id: string,
    data: { name?: string; description?: string; status?: 'DRAFT' | 'ACTIVE' | 'ARCHIVED'; variables?: Record<string, string>; fields?: TemplateFieldInput[] },
  ) {
    const orgId = user.org?.id!;
    await this.get(user, id); // ownership check

    return this.prisma.$transaction(async (tx) => {
      const template = await tx.template.update({
        where: { id },
        data: { name: data.name, description: data.description, status: data.status, variables: data.variables as object | undefined },
      });
      if (data.fields) {
        await tx.templateField.deleteMany({ where: { templateId: id } });
        await tx.templateField.createMany({
          data: data.fields.map((f) => ({ templateId: id, ...this.toFieldCreate(f) })),
        });
      }
      return tx.template.findUnique({ where: { id }, include: { fields: true } });
    });
  }

  async remove(user: AuthenticatedUser, id: string) {
    const orgId = user.org?.id!;
    const template = await this.prisma.template.findFirst({ where: { id, organizationId: orgId } });
    if (!template) throw new NotFoundException('Template not found');
    await this.prisma.template.delete({ where: { id } });
    return { success: true };
  }

  private toFieldCreate(f: TemplateFieldInput): Prisma.TemplateFieldCreateWithoutTemplateInput {
    return {
      type: f.type,
      name: f.name,
      key: f.key,
      isRequired: f.isRequired ?? true,
      pageNumber: f.pageNumber ?? 1,
      x: f.x,
      y: f.y,
      width: f.width,
      height: f.height,
      options: f.options as object | undefined,
    };
  }
}