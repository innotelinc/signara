import { Injectable } from '@nestjs/common';
import { CertificateProvider } from './provider.interface';
import { AcmeProvider } from './acme.provider';
import { CeruleanProvider } from './cerulean.provider';
import { InternalPkiProvider } from './internal-pki.provider';

/**
 * Resolves certificate providers by kind. A provider only becomes available
 * once its deployment configuration is present (env vars), so unconfigured
 * categories surface a clear provisioning/import path instead of empty errors.
 */
@Injectable()
export class ProviderRegistry {
  private readonly providers: CertificateProvider[];

  constructor(
    acme: AcmeProvider,
    cerulean: CeruleanProvider,
    internalPki: InternalPkiProvider,
  ) {
    this.providers = [acme, cerulean, internalPki];
  }

  get(kind: string): CertificateProvider {
    const provider = this.providers.find((p) => p.kind === kind);
    if (!provider) {
      throw new Error(`Unknown certificate provider: ${kind}`);
    }
    return provider;
  }

  configured(): CertificateProvider[] {
    return this.providers.filter((p) => p.isConfigured());
  }

  status(): Array<{ kind: string; configured: boolean }> {
    return this.providers.map((p) => ({ kind: p.kind, configured: p.isConfigured() }));
  }
}