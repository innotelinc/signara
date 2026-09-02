import { Controller, Get, Res } from '@nestjs/common';
import { ApiExcludeController, ApiTags } from '@nestjs/swagger';
import { HealthCheck, HealthCheckService, PrismaHealthIndicator } from '@nestjs/terminus';
import { Response } from 'express';
import { register, collectDefaultMetrics, Counter, Histogram } from 'prom-client';
import { PrismaService } from '../../prisma/prisma.service';
import { Public } from '../../common/decorators';

let metricsRegistered = false;

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
  ) {
    if (!metricsRegistered) {
      metricsRegistered = true;
      collectDefaultMetrics();
      new Counter({
        name: 'signara_http_requests_total',
        help: 'Total HTTP requests',
        labelNames: ['method', 'route', 'status'],
      });
      new Histogram({
        name: 'signara_http_request_duration_seconds',
        help: 'HTTP request duration in seconds',
        labelNames: ['method', 'route'],
        buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
      });
    }
  }

  @Public()
  @Get('health')
  healthCheck() {
    return { status: 'ok', service: 'signara-api', timestamp: new Date().toISOString() };
  }

  @Public()
  @Get('ready')
  @HealthCheck()
  readiness() {
    return this.health.check([
      () => this.prismaHealth.pingCheck('postgres', this.prisma),
    ]);
  }

  @Public()
  @Get('metrics')
  async metrics(@Res() res: Response) {
    res.set('Content-Type', register.contentType);
    res.send(await register.metrics());
  }
}