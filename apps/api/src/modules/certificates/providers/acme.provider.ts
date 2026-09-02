import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Client, crypto as acmeCrypto } from 'acme-client';
import { CertificateProvider, CertificateProvisionInput, IssuedCertificate } from './provider.interface';

interface DnsChallengeHandler {
  /** Called before the ACME server validates the dns-01 challenge. */
  setTxtRecord(name: string, value: string): Promise<void>;
  /** Called after validation completes (success or failure). */
  clearTxtRecord(name: string, value: string): Promise<void>;
}

/**
 * ACME (RFC 8555) certificate provisioning — works with any ACME server
 * (Let's Encrypt, step-ca, cert-manager, internal CAs exposing ACME).
 *
 * Enrollment flow (acme-client v5):
 *   createAccount -> createOrder -> getAuthorizations -> dns-01/http-01
 *   challenge -> finalizeOrder(csr) -> getCertificate
 *
 * The generated private key is returned as PEM; the certificates service
 * encrypts it at rest with CRYPTO_MASTER_KEY. Signing happens server-side
 * with that key — a true cryptographic (advanced) signature.
 *
 * Configuration (env):
 *   ACME_DIRECTORY_URL     ACME directory URL               (required)
 *   ACME_CONTACT_EMAIL     Account contact (mailto:)        (optional)
 *   ACME_DNS_PROVIDER      "cloudflare" enables dns-01 via CF_API_TOKEN
 *   ACME_HTTP_CHALLENGE    "true" exposes http-01 at <API_URL>/.well-known/
 *                          acme-challenge                  (optional)
 */
@Injectable()
export class AcmeProvider implements CertificateProvider {
  readonly kind = 'ACME' as const;
  private readonly logger = new Logger(AcmeProvider.name);

  constructor(private readonly config: ConfigService) {}

  isConfigured(): boolean {
    return Boolean(this.config.get<string>('ACME_DIRECTORY_URL'));
  }

  async provision(input: CertificateProvisionInput): Promise<IssuedCertificate> {
    const directoryUrl = this.config.get<string>('ACME_DIRECTORY_URL');
    if (!directoryUrl) {
      throw new Error('ACME_DIRECTORY_URL is not configured');
    }

    const accountKey = await acmeCrypto.createPrivateKey();
    const client = new Client({ directoryUrl, accountKey });

    const contact = this.config.get<string>('ACME_CONTACT_EMAIL') ?? input.email;
    await client.createAccount({
      termsOfServiceAgreed: true,
      contact: contact ? [`mailto:${contact}`] : [],
    });

    // Person certificates: commonName carries the signer identity. DNS orders
    // work on certificate-profile CAs such as step-ca; VA-style infrastructure
    // certificates use a host identifier instead.
    const identifier = (input.options?.identifier as string | undefined) ?? input.commonName.toLowerCase();
    const order = await client.createOrder({ identifiers: [{ type: 'dns', value: identifier }] });
    const authorizations = await client.getAuthorizations(order);
    const challenge =
      authorizations[0].challenges.find((c) => c.type === 'dns-01') ??
      authorizations[0].challenges.find((c) => c.type === 'http-01');
    if (!challenge) {
      throw new Error('ACME server offered no supported challenge type (dns-01/http-01)');
    }
    if (challenge.type === 'http-01' && !this.config.get('ACME_HTTP_CHALLENGE')) {
      throw new Error(
        'ACME offered only http-01 — set ACME_HTTP_CHALLENGE=true and expose <API_URL>/.well-known/acme-challenge (see Deployment.md)',
      );
    }

    let dnsHandler: DnsChallengeHandler | null = null;
    let dnsValue = '';
    if (challenge.type === 'dns-01') {
      dnsHandler = await this.buildDnsHandler(identifier, input);
      if (!dnsHandler) {
        throw new Error('ACME dns-01 requires ACME_DNS_PROVIDER=cloudflare (or a dnsHandler provisioning option)');
      }
      dnsValue = await client.getChallengeKeyAuthorization(challenge);
      await dnsHandler.setTxtRecord(`_acme-challenge.${identifier}`, dnsValue);
    }

    try {
      await client.verifyChallenge(authorizations[0], challenge);
      await client.completeChallenge(challenge);
      await client.waitForValidStatus(challenge);
    } finally {
      if (challenge.type === 'dns-01' && dnsHandler && dnsValue) {
        await dnsHandler.clearTxtRecord(`_acme-challenge.${identifier}`, dnsValue);
      }
    }

    const [privateKey, csr] = await acmeCrypto.createCsr({
      commonName: input.commonName,
      emailAddress: input.options?.emailAddress as string | undefined ?? input.email,
      ...(input.options?.altNames ? { altNames: input.options.altNames as string[] } : {}),
    });

    const finalized = await client.finalizeOrder(order, csr);
    if (finalized.status !== 'valid') {
      throw new Error(`ACME order did not finalize (status: ${finalized.status})`);
    }
    const chainPem = await client.getCertificate(finalized);
    const [leafPem, ...issuers] = acmeCrypto.splitPemChain(chainPem);
    const privateKeyPem = privateKey.toString('utf8'); // PEM text

    this.logger.log(`ACME issued certificate for ${identifier}`);
    return {
      certificatePem: leafPem,
      chainPem: issuers.join('\n'),
      privateKeyPem,
      keyAlgorithm: 'ECDSA-P256',
      validationLevel: 'DV',
      sourceRef: `acme:${identifier}`,
    };
  }

  // ------------------------------------------------------------ helpers ----
  private async buildDnsHandler(identifier: string, input: CertificateProvisionInput): Promise<DnsChallengeHandler | null> {
    const provider = this.config.get<string>('ACME_DNS_PROVIDER');
    if (provider === 'cloudflare') {
      const token = this.config.get<string>('CF_API_TOKEN');
      if (!token) throw new Error('ACME_DNS_PROVIDER=cloudflare requires CF_API_TOKEN');
      return this.cloudflareHandler(token, identifier);
    }
    return (input.options?.dnsHandler as DnsChallengeHandler | undefined) ?? null;
  }

  private cloudflareHandler(token: string, zoneName: string): DnsChallengeHandler {
    const api = 'https://api.cloudflare.com/client/v4';
    const zoneId = async (): Promise<string> => {
      const response = await fetch(`${api}/zones?name=${zoneName}&status=active`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const body = (await response.json()) as { result: Array<{ id: string }> };
      if (!body.result?.length) throw new Error(`Cloudflare zone not found for ${zoneName}`);
      return body.result[0].id;
    };

    return {
      async setTxtRecord(name, value) {
        const response = await fetch(`${api}/zones/${await zoneId()}/dns_records`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ type: 'TXT', name, content: value, ttl: 120 }),
        });
        if (!response.ok) throw new Error(`Cloudflare TXT create failed: HTTP ${response.status}`);
      },
      async clearTxtRecord(name) {
        const response = await fetch(`${api}/zones/${await zoneId()}/dns_records?type=TXT&name=${name}`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        const body = (await response.json()) as { result: Array<{ id: string }> };
        for (const record of body.result) {
          await fetch(`${api}/zones/${await zoneId()}/dns_records/${record.id}`, {
            method: 'DELETE',
            headers: { Authorization: `Bearer ${token}` },
          });
        }
      },
    };
  }
}