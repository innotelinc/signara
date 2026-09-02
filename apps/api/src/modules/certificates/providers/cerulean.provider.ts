import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { CertificateProvider, CertificateProvisionInput, IssuedCertificate } from './provider.interface';

interface CeruleanStatusResponse {
  id: string;
  status: 'queued' | 'processing' | 'complete' | 'failed';
  signature?: {
    value: string; // base64 DER signature
    format: string; // e.g. "PAdES", "CMS", "PKCS7"
  };
  certificate?: {
    pem: string;
    serialNumber: string;
    subjectDN: string;
    issuerDN: string;
    notBefore: string; // ISO-8601
    notAfter: string; // ISO-8601
    validationLevel?: string;
  };
  error?: string;
}

/**
 * Cerulean — managed certificate-backed document signing service.
 *
 * The API is a queue-based REST contract:
 *   1. POST   {CERULEAN_API_URL}/signatures   (documentHash + identifier + meta)
 *   2. POLL   GET {CERULEAN_API_URL}/signatures/{id}  until `status: complete`
 *   3. Use   `signature.value` + `certificate.pem` as signing evidence.
 *
 * The signer identity is validated by Cerulean (email/KYC), which elevates the
 * identity assurance level (see identity-assurance.ts).
 *
 * Configuration (env):
 *   CERULEAN_API_URL   default https://api.cerulean.com/v1
 *   CERULEAN_API_KEY   API key (X-API-Key header)
 *
 * NOTE: provider-specific JSON field names are implemented per the current
 * vendor contract — re-verify against Cerulean's API reference when adopting.
 */
@Injectable()
export class CeruleanProvider implements CertificateProvider {
  readonly kind = 'CERULEAN' as const;
  private readonly logger = new Logger(CeruleanProvider.name);

  constructor(private readonly config: ConfigService) {}

  private get baseUrl(): string {
    return this.config.get<string>('CERULEAN_API_URL') ?? 'https://api.cerulean.com/v1';
  }

  isConfigured(): boolean {
    return Boolean(this.config.get<string>('CERULEAN_API_KEY'));
  }

  async provision(input: CertificateProvisionInput): Promise<IssuedCertificate> {
    const apiKey = this.config.get<string>('CERULEAN_API_KEY');
    if (!apiKey) throw new Error('CERULEAN_API_KEY is not configured');

    // The digest to be signed is produced by the caller in signatures.service;
    // at provisioning time we only need the subject identity. When provision()
    // is invoked standalone the hash is supplied via options.signDigest.
    const signDigest = (input.options?.signDigest as string | undefined) ?? '';

    const created = await this.call<{ id: string }>('/signatures', apiKey, {
      method: 'POST',
      body: {
        documentHash: signDigest, // sha256 hex of the content binding
        identifier: input.email ?? input.commonName,
        meta: { organizationId: input.organizationId, signerName: input.commonName },
      },
    });

    const result = await this.poll(created.id, apiKey, 30, 3_000);
    if (result.status !== 'complete' || !result.certificate) {
      throw new Error(`Cerulean signing failed: ${result.error ?? result.status}`);
    }

    this.logger.log(`Cerulean completed signature ${created.id}`);
    return {
      certificatePem: result.certificate.pem,
      chainPem: undefined,
      privateKeyPem: undefined, // key stays at Cerulean — signatures come back signed
      keyAlgorithm: 'RSA-2048',
      validationLevel: result.certificate.validationLevel ?? 'OV',
      sourceRef: `cerulean:${created.id}`,
      // Signature evidence forwarded through the options bag
      ...(result.signature ? { signatureValue: result.signature.value, signatureFormat: result.signature.format } : {}),
    };
  }

  // ------------------------------------------------------------ helpers ----
  private async call<T>(path: string, apiKey: string, init: { method?: string; body?: unknown }): Promise<T> {
    const response = await fetch(`${this.baseUrl}${path}`, {
      method: init.method ?? 'GET',
      headers: {
        'X-API-Key': apiKey,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: init.body ? JSON.stringify(init.body) : undefined,
    });
    if (!response.ok) {
      throw new Error(`Cerulean API error: HTTP ${response.status}`);
    }
    return (await response.json()) as T;
  }

  private async poll(id: string, apiKey: string, attempts: number, intervalMs: number): Promise<CeruleanStatusResponse> {
    let last: CeruleanStatusResponse | null = null;
    for (let i = 0; i < attempts; i++) {
      last = await this.call<CeruleanStatusResponse>(`/signatures/${id}`, apiKey, {});
      if (last.status === 'complete' || last.status === 'failed') return last;
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
    throw new Error(`Cerulean signature ${id} did not complete within ${attempts} polls`);
  }
}