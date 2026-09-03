import { Controller, Get, Res } from '@nestjs/common';
import { ApiExcludeController, ApiTags } from '@nestjs/swagger';
import { HealthCheck, HealthCheckService, PrismaHealthIndicator } from '@nestjs/terminus';
import { Response } from 'express';
import { register } from 'prom-client';
import { PrismaService } from '../../prisma/prisma.service';
import { Public } from '../../common/decorators';

/**
 * Liveness (/health), readiness (/ready) and Prometheus metrics (/metrics).
 * These endpoints are excluded from the /api/v1 prefix and are always public —
 * scrape access must be network-restricted (see infra/monitoring).
 */
@ApiExcludeController()
@ApiTags('system')
@Controller()
export class HealthController {
  constructor(
    private readonly health: HealthCheckService,
    private readonly prismaHealth: PrismaHealthIndicator,
    private readonly prisma: PrismaService,
  ) {}

  @Public()
  @Get('health')
  healthCheck() {
    return { status: 'ok', service: 'signara-api', timestamp: new Date().toISOString() };
  }

  @Public()
  @Get('ready')
  @HealthCheck()
  readiness() {
    return this.health.check([() => this.prismaHealth.pingCheck('postgres', this.prisma)]);
  }

  @Public()
  @Get('metrics')
  async metrics(@Res() res: Response) {
    res.set('Content-Type', register.contentType);
    res.send(await register.metrics());
  }
}
