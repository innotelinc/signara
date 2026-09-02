import { Body, Controller, Delete, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { FieldType } from '@prisma/client';
import { Type } from 'class-transformer';
import { IsArray, IsBoolean, IsEnum, IsInt, IsObject, IsOptional, IsString, Min, ValidateNested } from 'class-validator';
import { TemplatesService, TemplateFieldInput } from './templates.service';
import { CurrentUser, Permissions, TenantRequired } from '../../common/decorators';
import { AuthenticatedUser } from '../../common/types';

class TemplateFieldDto implements TemplateFieldInput {
  @IsEnum(FieldType) type!: FieldType;
  @IsOptional() @IsString() name?: string;
  @IsOptional() @IsString() key?: string;
  @IsOptional() @IsBoolean() isRequired?: boolean;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) pageNumber?: number;
  @IsOptional() @Type(() => Number) @IsInt() x?: number;
  @IsOptional() @Type(() => Number) @IsInt() y?: number;
  @IsOptional() @Type(() => Number) @IsInt() width?: number;
  @IsOptional() @Type(() => Number) @IsInt() height?: number;
  @IsOptional() @IsObject() options?: unknown;
}

class CreateTemplateDto {
  @IsString() name!: string;
  @IsOptional() @IsString() description?: string;
  @IsOptional() @IsString() workspaceId?: string;
  @IsOptional() @IsObject() variables?: Record<string, string>;
  @IsOptional() @IsArray() @ValidateNested({ each: true }) @Type(() => TemplateFieldDto) fields?: TemplateFieldDto[];
}

class UpdateTemplateDto {
  @IsOptional() @IsString() name?: string;
  @IsOptional() @IsString() description?: string;
  @IsOptional() @IsEnum(['DRAFT', 'ACTIVE', 'ARCHIVED']) status?: 'DRAFT' | 'ACTIVE' | 'ARCHIVED';
  @IsOptional() @IsObject() variables?: Record<string, string>;
  @IsOptional() @IsArray() @ValidateNested({ each: true }) @Type(() => TemplateFieldDto) fields?: TemplateFieldDto[];
}

class TemplateQueryDto {
  @IsOptional() @IsEnum(['DRAFT', 'ACTIVE', 'ARCHIVED']) status?: 'DRAFT' | 'ACTIVE' | 'ARCHIVED';
  @IsOptional() @IsString() workspaceId?: string;
  @IsOptional() limit?: number;
  @IsOptional() offset?: number;
}

@ApiTags('templates')
@Controller('templates')
@TenantRequired()
export class TemplatesController {
  constructor(private readonly templates: TemplatesService) {}

  @Post()
  @Permissions('templates.create')
  @ApiOperation({ summary: 'Create a template with reusable fields' })
  create(@CurrentUser() user: AuthenticatedUser, @Body() dto: CreateTemplateDto) {
    return this.templates.create(user, dto);
  }

  @Get()
  @Permissions('templates.read')
  @ApiOperation({ summary: 'List templates' })
  list(@CurrentUser() user: AuthenticatedUser, @Query() query: TemplateQueryDto) {
    return this.templates.list(user, query);
  }

  @Get(':id')
  @Permissions('templates.read')
  @ApiOperation({ summary: 'Get a template with its fields' })
  get(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.templates.get(user, id);
  }

  @Patch(':id')
  @Permissions('templates.update')
  @ApiOperation({ summary: 'Update a template (replace fields/variables)' })
  update(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string, @Body() dto: UpdateTemplateDto) {
    return this.templates.update(user, id, dto);
  }

  @Delete(':id')
  @Permissions('templates.delete')
  @ApiOperation({ summary: 'Delete a template' })
  remove(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.templates.remove(user, id);
  }
}