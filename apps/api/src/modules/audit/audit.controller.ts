import { Body, Controller, Get, Header, Post, Query, Res } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Response } from 'express';
import { AuditOutcome } from '@prisma/client';
import { AuditService } from './audit.service';
import { CurrentUser, Permissions, Public, TenantRequired } from '../../common/decorators';
import { AuthenticatedUser } from '../../common/types';

@ApiTags('audit')
@Controller('audit')
@TenantRequired()
export class AuditController {
  constructor(private readonly audit: AuditService) {}

  @Get()
  @Permissions('audit.read')
  @ApiOperation({ summary: 'Query the organization audit log' })
  list(
    @CurrentUser() user: AuthenticatedUser,
    @Query('action') action?: string,
    @Query('resourceType') resourceType?: string,
    @Query('resourceId') resourceId?: string,
    @Query('outcome') outcome?: AuditOutcome,
    @Query('actorEmail') actorEmail?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
  ) {
    return this.audit.list(user, {
      action,
      resourceType,
      resourceId,
      outcome,
      actorEmail,
      from: from ? new Date(from) : undefined,
      to: to ? new Date(to) : undefined,
      limit: limit ? Number(limit) : undefined,
      offset: offset ? Number(offset) : undefined,
    });
  }

  @Get('export')
  @Permissions('audit.export')
  @Header('Content-Type', 'text/csv')
  @Header('Content-Disposition', 'attachment; filename="audit.csv"')
  @ApiOperation({ summary: 'Export the audit log as CSV (max 50k rows)' })
  async export(
    @CurrentUser() user: AuthenticatedUser,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('action') action?: string,
    @Res() res?: Response,
  ) {
    const csv = await this.audit.export(user, {
      from: from ? new Date(from) : undefined,
      to: to ? new Date(to) : undefined,
      action,
    });
    if (res) res.send(csv);
  }

  /**
   * CSP violation reports submitted by browsers. Public by design; body is
   * sanitized (no user-controlled HTML) and stored as an audit row.
   */
  @Public()
  @Post('csp-report')
  @ApiOperation({ summary: 'Ingest Content-Security-Policy violation reports' })
  async cspReport(@Body() body: Record<string, unknown>) {
    const report = (body as { 'csp-report'?: Record<string, unknown> })['csp-report'] ?? body;
    await this.audit.record({
      action: 'CSP_VIOLATION',
      resourceType: 'browser',
      metadata: {
        documentUri: report['document-uri'],
        blockedUri: report['blocked-uri'],
        violatedDirective: report['violated-directive'],
      },
    });
    return { received: true };
  }
}