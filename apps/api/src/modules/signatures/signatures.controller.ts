import { Body, Controller, Get, Param, Post, Query, Req } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Request } from 'express';
import { SigningMode, SignerRole, SignatureType } from '@prisma/client';
import { Type } from 'class-transformer';
import { IsArray, IsBoolean, IsDate, IsEnum, IsInt, IsObject, IsOptional, IsString, Min, ValidateNested } from 'class-validator';
import { SignaturesService } from './signatures.service';
import { CurrentUser, Permissions, Public, TenantRequired } from '../../common/decorators';
import { AuthenticatedUser } from '../../common/types';

class SignerDto {
  @IsString() email!: string;
  @IsOptional() @IsString() name?: string;
  @IsOptional() @IsEnum(SignerRole) role?: SignerRole;
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) orderIndex?: number;
}

class WorkflowRuleDto {
  @Type(() => Number) @IsInt() @Min(0) orderIndex!: number;
  @IsObject() condition!: Record<string, unknown>;
  @IsEnum(['APPROVE', 'ROUTE', 'REQUIRE', 'NOTIFY']) action!: 'APPROVE' | 'ROUTE' | 'REQUIRE' | 'NOTIFY';
  @IsOptional() @IsString() targetSignerId?: string;
}

class CreateRequestDto {
  @IsString() documentId!: string;
  @IsOptional() @IsString() title?: string;
  @IsOptional() @IsString() message?: string;
  @IsOptional() @Type(() => Date) @IsDate() deadline?: Date;
  @IsOptional() @IsEnum(SigningMode) mode?: SigningMode;
  @IsOptional() @IsBoolean() sendInvites?: boolean;
  @IsArray() @ValidateNested({ each: true }) @Type(() => SignerDto) signers!: SignerDto[];
  @IsOptional() @IsArray() @ValidateNested({ each: true }) @Type(() => WorkflowRuleDto) workflowRules?: WorkflowRuleDto[];
}

class SignDto {
  @IsOptional() @IsEnum(SignatureType) type?: SignatureType;
  @IsOptional() @IsString() certificateSerial?: string;
  @IsOptional() @IsString() signedHash?: string;
  @IsOptional() @IsString() cryptoAlgorithm?: string;
  @IsOptional() @IsString() signatureData?: string;
  /** Certificate to bind the signature to (certificate-backed signing). */
  @IsOptional() @IsString() certificateId?: string;
  /** Cryptographic signature value (base64) produced by the key holder. */
  @IsOptional() @IsString() signatureValue?: string;
}

@ApiTags('signatures')
@Controller('signatures')
export class SignaturesController {
  constructor(private readonly signatures: SignaturesService) {}

  // -------------------------------------------------- tenant endpoints -----
  @Post('requests')
  @TenantRequired()
  @Permissions('signing.send')
  @ApiOperation({ summary: 'Create a signing request (sequential or parallel)' })
  create(@CurrentUser() user: AuthenticatedUser, @Body() dto: CreateRequestDto) {
    return this.signatures.createRequest(user, dto);
  }

  @Get('requests')
  @TenantRequired()
  @Permissions('signing.read')
  @ApiOperation({ summary: 'List signing requests' })
  list(
    @CurrentUser() user: AuthenticatedUser,
    @Query('status') status?: string,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
  ) {
    return this.signatures.listRequests(user, {
      status: status as never,
      limit: limit ? Number(limit) : undefined,
      offset: offset ? Number(offset) : undefined,
    });
  }

  @Get('requests/:id')
  @TenantRequired()
  @Permissions('signing.read')
  @ApiOperation({ summary: 'Get a signing request with events and signatures' })
  get(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.signatures.getRequest(user, id);
  }

  @Post('requests/:id/cancel')
  @TenantRequired()
  @Permissions('signing.cancel')
  @ApiOperation({ summary: 'Cancel a signing request' })
  cancel(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string, @Body('reason') reason?: string) {
    return this.signatures.cancel(user, id, reason);
  }

  @Post('requests/:id/remind')
  @TenantRequired()
  @Permissions('signing.remind')
  @ApiOperation({ summary: 'Send reminders to pending signers (max once per 24h)' })
  remind(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string, @Body('signerId') signerId?: string) {
    return this.signatures.remind(user, id, signerId);
  }

  @Get('requests/:id/evidence')
  @TenantRequired()
  @Permissions('audit.read')
  @ApiOperation({ summary: 'Generate the signature evidence report' })
  evidence(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.signatures.evidenceReport(user, id);
  }

  // -------------------------------------------------- public token links ----
  @Public()
  @Get('public/:token')
  @ApiOperation({ summary: 'Public signing session (unguessable per-signer token)' })
  session(@Param('token') token: string, @Req() req: Request) {
    return this.signatures.publicSession(token, this.ctx(req));
  }

  @Public()
  @Post('public/:token/sign')
  @ApiOperation({ summary: 'Record a signature from the public session' })
  sign(@Param('token') token: string, @Body() dto: SignDto, @Req() req: Request) {
    return this.signatures.sign(token, dto, this.ctx(req));
  }

  @Public()
  @Post('public/:token/decline')
  @ApiOperation({ summary: 'Decline to sign' })
  decline(@Param('token') token: string, @Body('reason') reason: string | undefined, @Req() req: Request) {
    return this.signatures.decline(token, reason, this.ctx(req));
  }

  @Public()
  @Get('public/:token/events')
  @ApiOperation({ summary: 'Event history visible to the signer' })
  events(@Param('token') token: string) {
    return this.signatures.publicEvents(token);
  }

  private ctx(req: Request) {
    return { ipAddress: String(req.ip ?? 'unknown'), userAgent: String(req.headers['user-agent'] ?? '') };
  }
}