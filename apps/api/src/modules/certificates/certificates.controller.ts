import { Body, Controller, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { CertificateStatus } from '@prisma/client';
import { IsEmail, IsEnum, IsHexColor, IsObject, IsOptional, IsString } from 'class-validator';
import { CertificatesService } from './certificates.service';
import { CurrentUser, Permissions, TenantRequired } from '../../common/decorators';
import { AuthenticatedUser } from '../../common/types';

class ImportCertificateDto {
  @IsString() certificatePem!: string;
  @IsOptional() @IsString() chainPem?: string;
  @IsOptional() @IsString() privateKeyPem?: string;
  @IsOptional() @IsEnum(['INTERNAL_PKI', 'WEB', 'ACME', 'CERULEAN']) provider?: 'INTERNAL_PKI' | 'WEB' | 'ACME' | 'CERULEAN';
  @IsOptional() @IsEnum(['DV', 'OV', 'EV']) validationLevel?: 'DV' | 'OV' | 'EV';
  @IsOptional() @IsString() commonName?: string;
}

class ProvisionCertificateDto {
  @IsEnum(['ACME', 'CERULEAN', 'INTERNAL_PKI']) provider!: 'ACME' | 'CERULEAN' | 'INTERNAL_PKI';
  @IsString() commonName!: string;
  @IsOptional() @IsEmail() email?: string;
  @IsOptional() @IsObject() options?: Record<string, unknown>;
}

class VerifyCertificateDto {
  @IsOptional() @IsString() certificatePem?: string;
  @IsOptional() @IsString() certificateId?: string;
  @IsOptional() @IsString() signatureValue?: string;
  @IsOptional() @IsString() signedHash?: string;
}

@ApiTags('certificates')
@Controller('certificates')
@TenantRequired()
export class CertificatesController {
  constructor(private readonly certificates: CertificatesService) {}

  @Get()
  @Permissions('certificates.read')
  @ApiOperation({ summary: 'List certificates for the organization' })
  list(
    @CurrentUser() user: AuthenticatedUser,
    @Query('status') status?: CertificateStatus,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
  ) {
    return this.certificates.list(user, {
      status,
      limit: limit ? Number(limit) : undefined,
      offset: offset ? Number(offset) : undefined,
    });
  }

  @Get('providers')
  @Permissions('certificates.read')
  @ApiOperation({ summary: 'Provider configuration status (ACME, Cerulean, Internal PKI)' })
  providers() {
    return this.certificates.providerStatus();
  }

  @Post('import')
  @Permissions('certificates.manage')
  @ApiOperation({ summary: 'Import an existing certificate (enterprise PKI / internal CA)' })
  importCertificate(@CurrentUser() user: AuthenticatedUser, @Body() dto: ImportCertificateDto) {
    return this.certificates.importCertificate(user, dto);
  }

  @Post('provision')
  @Permissions('certificates.manage')
  @ApiOperation({ summary: 'Provision a certificate via ACME, Cerulean, or an internal PKI script' })
  provision(@CurrentUser() user: AuthenticatedUser, @Body() dto: ProvisionCertificateDto) {
    return this.certificates.provision(user, dto);
  }

  @Post('verify')
  @Permissions('certificates.read')
  @ApiOperation({ summary: 'Verify a certificate chain and (optionally) a signature value' })
  verify(@Body() dto: VerifyCertificateDto) {
    return this.certificates.verify(dto);
  }

  @Get(':id')
  @Permissions('certificates.read')
  @ApiOperation({ summary: 'Get a certificate' })
  get(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.certificates.get(user, id);
  }

  @Patch(':id/revoke')
  @Permissions('certificates.manage')
  @ApiOperation({ summary: 'Revoke a certificate' })
  revoke(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string, @Body('reason') reason?: string) {
    return this.certificates.revoke(user, id, reason);
  }
}