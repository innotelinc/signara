import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { certificateExpiryTimestamp } from '../../common/metrics';

@Injectable()
export class CertificateMetricsService implements OnModuleInit, OnModuleDestroy {
  private timer?: NodeJS.Timeout;

  constructor(private readonly prisma: PrismaService) {}

  onModuleInit(): void {
    void this.refresh();
    this.timer = setInterval(() => void this.refresh(), 60_000);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  private async refresh(): Promise<void> {
    try {
      const certificates = await this.prisma.signingCertificate.findMany({
        where: { status: 'ACTIVE' },
        select: { id: true, organizationId: true, notAfter: true },
      });
      certificateExpiryTimestamp.reset();
      for (const certificate of certificates) {
        certificateExpiryTimestamp.set(
          { certificate: certificate.id, organization: certificate.organizationId },
          certificate.notAfter.getTime() / 1000,
        );
      }
    } catch {
      // Preserve the last successful values during a transient database outage.
    }
  }
}
