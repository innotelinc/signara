import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { FileInterceptor } from '@nestjs/platform-express';
import { DocumentStatus } from '@prisma/client';
import { IsArray, IsEnum, IsOptional, IsString } from 'class-validator';
import { DocumentsService } from './documents.service';
import { CurrentUser, Permissions, TenantRequired } from '../../common/decorators';
import { AuthenticatedUser } from '../../common/types';

class UploadDto {
  @IsOptional() @IsString() title?: string;
  @IsOptional() @IsString() description?: string;
  @IsOptional() @IsString() workspaceId?: string;
  @IsOptional() @IsArray() @IsString({ each: true }) tags?: string[];
}

class DocumentQueryDto {
  @IsOptional() @IsEnum(DocumentStatus) status?: DocumentStatus;
  @IsOptional() @IsString() workspaceId?: string;
  @IsOptional() @IsString() search?: string;
  @IsOptional() limit?: number;
  @IsOptional() offset?: number;
}

class UpdateDocumentDto {
  @IsOptional() @IsString() title?: string;
  @IsOptional() @IsString() description?: string;
  @IsOptional() @IsArray() @IsString({ each: true }) tags?: string[];
  @IsOptional() @IsString() workspaceId?: string;
}

class AddVersionDto {
  @IsOptional() @IsString() changeNote?: string;
}

@ApiTags('documents')
@Controller('documents')
@TenantRequired()
export class DocumentsController {
  constructor(private readonly documents: DocumentsService) {}

  @Post('upload')
  @Permissions('documents.create')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 50 * 1024 * 1024 } }))
  @ApiOperation({ summary: 'Upload a document (PDF, DOCX, or image)' })
  upload(
    @CurrentUser() user: AuthenticatedUser,
    @UploadedFile() file: Express.Multer.File,
    @Body() dto: UploadDto,
  ) {
    return this.documents.upload(user, file, dto);
  }

  @Get()
  @Permissions('documents.read')
  @ApiOperation({ summary: 'List documents (optionally searched via Meilisearch)' })
  list(@CurrentUser() user: AuthenticatedUser, @Query() query: DocumentQueryDto) {
    return this.documents.list(user, query);
  }

  @Get(':id')
  @Permissions('documents.read')
  @ApiOperation({ summary: 'Get a document with its version history' })
  get(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.documents.get(user, id);
  }

  @Get(':id/download')
  @Permissions('documents.download')
  @ApiOperation({ summary: 'Get a time-limited download URL (optionally for a version)' })
  download(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string, @Query('version') version?: string) {
    return this.documents.download(user, id, version ? Number(version) : undefined);
  }

  @Patch(':id')
  @Permissions('documents.update')
  @ApiOperation({ summary: 'Update document metadata' })
  update(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string, @Body() dto: UpdateDocumentDto) {
    return this.documents.updateMetadata(user, id, dto);
  }

  @Post(':id/versions')
  @Permissions('documents.update')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 50 * 1024 * 1024 } }))
  @ApiOperation({ summary: 'Upload a new version of a document' })
  addVersion(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @UploadedFile() file: Express.Multer.File,
    @Body() dto: AddVersionDto,
  ) {
    return this.documents.addVersion(user, id, file, dto.changeNote);
  }

  @Delete(':id')
  @Permissions('documents.delete')
  @ApiOperation({ summary: 'Soft-delete a document' })
  remove(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.documents.softDelete(user, id);
  }
}