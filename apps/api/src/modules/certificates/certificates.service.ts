import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash, createPrivateKey, createPublicKey, sign as nodeSign, verify as nodeVerify } from 'node:crypto';
import * as forge from 'node-forge';
import { CertificateStatus, CertificateProvider as ProviderKind } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { decryptSecret, encryptSecret } from '../../common/crypto';
import { AuthenticatedUser } from '../../common/types';
import { ProviderRegistry } from './providers/provider-registry';
import { IssuedCertificate } from './providers/provider.interface';
import { AssuranceLevel, computeIdentityAssurance, ProviderValidation } from './identity-assurance';

export interface CertificateEvidence {
  certificateId: string;
  serialNumber: string;
  commonName: string;
  email: string | null;
  issuerDN: string | null;
  provider: ProviderKind;
  validationLevel: string | null;
  notAfter: Date;
  signatureValue: string;
  signatureFormat: string;
  cryptoAlgorithm: string;
  identityAssurance: { score: number; level: AssuranceLevel };
}

interface NormalizedPem {
  serialNumber: string;
  subjectDN: string;
  issuerDN: string;
  notBefore: Date;
  notAfter: Date;
  email: string | null;
}

const CERT_SELECT = {
  id: true,
  organizationId: true,
  userId: true,
  provider: true,
  status: true,
  commonName: true,
  email: true,
  serialNumber: true,
  subjectDN: true,
  issuerDN: true,
  notBefore: true,
  notAfter: true,
  certificatePem: true,
  keyAlgorithm: true,
  validationLevel: true,
  sourceRef: true,
  createdAt: true,
  updatedAt: true,
  revokedAt: true,
  revokedReason: true,
} as const;

@Injectable()
export class CertificatesService {
  private readonly logger = new Logger(CertificatesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly registry: ProviderRegistry,
  ) {}

  // ------------------------------------------------------------- queries ----
  async list(user: AuthenticatedUser, query: { status?: CertificateStatus; limit?: number; offset?: number }) {
    const orgId = user.org?.id;
    if (!orgId) throw new ForbiddenException('No active tenant');

    const where = { organizationId: orgId, ...(query.status ? { status: query.status } : {}) };
    const [total, items] = await this.prisma.$transaction([
      this.prisma.signingCertificate.count({ where }),
      this.prisma.signingCertificate.findMany({
        where,
        select: CERT_SELECT,
        orderBy: { createdAt: 'desc' },
        skip: query.offset ?? 0,
        take: Math.min(query.limit ?? 25, 100),
      }),
    ]);
    return { total, items };
  }

  async get(user: AuthenticatedUser, id: string) {
    const orgId = user.org?.id!;
    const certificate = await this.prisma.signingCertificate.findFirst({
      where: { id, organizationId: orgId },
      select: CERT_SELECT,
    });
    if (!certificate) throw new NotFoundException('Certificate not found');
    return certificate;
  }

  providerStatus() {
    return this.registry.status();
  }

  // -------------------------------------------------------------- import ----
  /**
   * Imports an existing certificate (enterprise PKI / internal CA). The
   * optional private key is verified against the certificate and encrypted at
   * rest with CRYPTO_MASTER_KEY. Re-importing a serial reactivates the row.
   */
  async importCertificate(
    user: AuthenticatedUser,
    input: { certificatePem: string; chainPem?: string; privateKeyPem?: string; provider?: 'INTERNAL_PKI' | 'WEB' | 'ACME' | 'CERULEAN'; validationLevel?: string; commonName?: string },
  ) {
    const orgId = user.org?.id!;
    const normalized = this.parseCertificatePem(input.certificatePem);
    const commonName = input.commonName ?? this.cnFromSubject(normalized.subjectDN) ?? input.certificatePem.slice(0, 24);

    let privateKeyEnc: string | null = null;
    if (input.privateKeyPem) {
      this.assertPrivateKeyMatches(input.privateKeyPem, input.certificatePem);
      privateKeyEnc = encryptSecret(input.privateKeyPem, this.masterKey());
    }

    const existing = await this.prisma.signingCertificate.findUnique({
      where: { organizationId_serialNumber: { organizationId: orgId, serialNumber: normalized.serialNumber } },
    });

    const data = {
      organizationId: orgId,
      userId: user.id,
      provider: (input.provider ?? 'INTERNAL_PKI') as ProviderKind,
      status: CertificateStatus.ACTIVE,
      commonName,
      email: normalized.email,
      serialNumber: normalized.serialNumber,
      subjectDN: normalized.subjectDN,
      issuerDN: normalized.issuerDN,
      notBefore: normalized.notBefore,
      notAfter: normalized.notAfter,
      certificatePem: input.certificatePem,
      chainPem: input.chainPem,
      privateKeyEnc,
      keyAlgorithm: input.certificatePem.includes('BEGIN EC') ? 'ECDSA' : 'RSA',
      validationLevel: input.validationLevel ?? 'OV',
      createdBy: user.id,
      revokedAt: null,
      revokedReason: null,
    };

    const certificate = existing
      ? await this.prisma.signingCertificate.update({ where: { id: existing.id }, data })
      : await this.prisma.signingCertificate.create({ data });

    this.logger.log(`Imported certificate ${normalized.serialNumber} (provider=${data.provider})`);
    return this.sanitize(certificate);
  }

  // ------------------------------------------------------------ provision ---
  async provision(
    user: AuthenticatedUser,
    input: { provider: string; commonName: string; email?: string; options?: Record<string, unknown> },
  ) {
    const orgId = user.org?.id!;
    const provider = this.registry.get(input.provider.toUpperCase());
    if (!provider.isConfigured()) {
      throw new BadRequestException(
        `Certificate provider ${input.provider} is not configured for this deployment (see Deployment.md)`,
      );
    }

    const issued = await provider.provision({
      organizationId: orgId,
      commonName: input.commonName,
      email: input.email,
      options: input.options,
    });

    const normalized = this.parseCertificatePem(issued.certificatePem);
    const certificate = await this.persistIssued(orgId, user.id, provider.kind as ProviderKind, issued, normalized, input.email);
    this.logger.log(`Provisioned certificate ${normalized.serialNumber} via ${provider.kind}`);
    return this.sanitize(certificate);
  }

  /** Persists provider-issued PEMs (encrypting the key if present). */
  private async persistIssued(
    organizationId: string,
    userId: string,
    provider: ProviderKind,
    issued: IssuedCertificate,
    normalized: NormalizedPem,
    emailHint?: string,
  ) {
    const privateKeyEnc = issued.privateKeyPem ? encryptSecret(issued.privateKeyPem, this.masterKey()) : undefined;
    const existing = await this.prisma.signingCertificate.findUnique({
      where: { organizationId_serialNumber: { organizationId, serialNumber: normalized.serialNumber } },
    });
    const data = {
      organizationId,
      userId,
      provider,
      status: CertificateStatus.ACTIVE,
      commonName: normalized.email ?? this.cnFromSubject(normalized.subjectDN) ?? emailHint ?? 'signer',
      email: normalized.email ?? emailHint,
      serialNumber: normalized.serialNumber,
      subjectDN: normalized.subjectDN,
      issuerDN: normalized.issuerDN,
      notBefore: normalized.notBefore,
      notAfter: normalized.notAfter,
      certificatePem: issued.certificatePem,
      chainPem: issued.chainPem,
      privateKeyEnc,
      keyAlgorithm: issued.keyAlgorithm ?? (normalized.email ? 'RSA' : 'ECDSA'),
      validationLevel: issued.validationLevel ?? 'OV',
      sourceRef: issued.sourceRef,
      createdBy: userId,
    };
    return existing
      ? this.prisma.signingCertificate.update({ where: { id: existing.id }, data })
      : this.prisma.signingCertificate.create({ data });
  }

  // -------------------------------------------------------------- revoke ----
  async revoke(user: AuthenticatedUser, id: string, reason?: string) {
    const orgId = user.org?.id!;
    const certificate = await this.prisma.signingCertificate.findFirst({ where: { id, organizationId: orgId } });
    if (!certificate) throw new NotFoundException('Certificate not found');

    const updated = await this.prisma.signingCertificate.update({
      where: { id },
      data: { status: CertificateStatus.REVOKED, revokedAt: new Date(), revokedReason: reason },
    });
    // TODO(extension): push revocation to the provider (Cerulean API / CRL / OCSP publisher).
    return this.sanitize(updated);
  }

  // ------------------------------------------------------- sign integration -
  /**
   * Applies a certificate-backed signature during the signing flow.
   *
   * Resolution order:
   *   1. Load the named certificate (tenant-scoped, ACTIVE, unexpired).
   *   2. Bind the certificate identity to the signer (email or user match).
   *   3. If the deployment holds the private key, sign the content digest
   *      server-side. Otherwise the caller must supply a signature produced by
   *      the provider (validated against the certificate's public key).
   *   4. Compute + return the identity assurance snapshot for evidence.
   */
  async signWithCertificate(input: {
    organizationId: string;
    certificateId: string;
    signerUserId?: string | null;
    signerEmail: string;
    contentHash: string;
    providedSignature?: string;
  }) {
    const { organizationId, certificateId, signerUserId, signerEmail, contentHash, providedSignature } = input;

    const certificate = await this.prisma.signingCertificate.findFirst({
      where: { id: certificateId, organizationId },
    });
    if (!certificate) throw new NotFoundException('Certificate not found');
    if (certificate.status !== 'ACTIVE' || certificate.revokedAt) {
      throw new ForbiddenException('Certificate is not active');
    }
    if (certificate.notAfter < new Date()) {
      throw new ForbiddenException(`Certificate expired ${certificate.notAfter.toISOString()}`);
    }

    const certMatchesSigner =
      (certificate.email !== null && certificate.email.toLowerCase() === signerEmail.toLowerCase()) ||
      (certificate.userId !== null && certificate.userId === signerUserId);
    if (!certMatchesSigner) {
      throw new ForbiddenException('Certificate identity does not match the signer');
    }

    const publicKey = createPublicKey(certificate.certificatePem);
    const keyType = publicKey.asymmetricKeyType ?? 'rsa';

    let signatureValue: string;
    let signatureFormat: string;

    if (providedSignature) {
      signatureValue = providedSignature;
      signatureFormat = this.formatLabel(keyType);
      const digest = Buffer.from(contentHash, 'hex');
      const payload = Buffer.from(providedSignature, 'base64');
      const valid = nodeVerify(this.hashName(keyType), digest, publicKey, payload);
      if (!valid) {
        throw new ForbiddenException('Provided signature does not verify against the certificate');
      }
    } else if (certificate.privateKeyEnc) {
      const privateKeyPem = decryptSecret(certificate.privateKeyEnc, this.masterKey());
      const privateKey = createPrivateKey(privateKeyPem);
      signatureFormat = this.formatLabel(keyType);
      // Sign the digest bytes (the hash itself), bound like CMS detached data.
      const payload = nodeSign(this.hashName(keyType), Buffer.from(contentHash, 'hex'), privateKey);
      signatureValue = payload.toString('base64');
    } else {
      throw new BadRequestException(
        'This certificate is held by the provider — the signature must be supplied (signatureValue)',
      );
    }

    // Evidence computed for this signature: users are resolved from the signer
    // record by the signatures service; here we assume email-verified accounts
    // unless told otherwise (the caller enriches factors).
    const assurance = computeIdentityAssurance({
      certificateValid: true,
      certIdentityMatch: true,
      accountVerified: Boolean(signerUserId),
      mfaEnabled: await this.signerHasMfa(signerUserId),
      revocationChecked: false, // CRL/OCSP fetching is an extension point
      providerValidation: this.validationLevel(certificate.validationLevel),
    });

    return {
      certificateId: certificate.id,
      serialNumber: certificate.serialNumber,
      commonName: certificate.commonName,
      email: certificate.email,
      issuerDN: certificate.issuerDN,
      provider: certificate.provider,
      validationLevel: certificate.validationLevel,
      notAfter: certificate.notAfter,
      signatureValue,
      signatureFormat,
      cryptoAlgorithm: `${this.hashName(keyType)} (detached — signed over content digest)`,
      identityAssurance: { score: assurance.score, level: assurance.level },
    } satisfies CertificateEvidence;
  }

  // ------------------------------------------------------- verify endpoint ---
  async verify(input: {
    certificatePem?: string;
    certificateId?: string;
    signatureValue?: string;
    signedHash?: string;
  }) {
    let pem = input.certificatePem;
    if (input.certificateId) {
      const certificate = await this.prisma.signingCertificate.findUnique({ where: { id: input.certificateId } });
      if (!certificate) throw new NotFoundException('Certificate not found');
      pem = certificate.certificatePem;
    }
    if (!pem) throw new BadRequestException('certificatePem or certificateId is required');

    const normalized = this.parseCertificatePem(pem);
    const reasons: string[] = [];
    const now = new Date();

    if (normalized.notBefore > now) reasons.push(`Certificate is not yet valid (notBefore ${normalized.notBefore.toISOString()})`);
    if (normalized.notAfter < now) reasons.push(`Certificate expired at ${normalized.notAfter.toISOString()}`);

    let signatureVerified: boolean | null = null;
    if (input.signatureValue && input.signedHash) {
      try {
        const publicKey = createPublicKey(pem);
        signatureVerified = nodeVerify(
          'sha256',
          Buffer.from(input.signedHash, 'hex'),
          publicKey,
          Buffer.from(input.signatureValue, 'base64'),
        );
        if (!signatureVerified) reasons.push('Signature does not verify against the certificate public key');
      } catch {
        reasons.push('Signature verification failed (malformed value or unsupported key type)');
      }
    }

    const assurance = computeIdentityAssurance({
      certificateValid: reasons.length === 0,
      certIdentityMatch: true, // verification only — caller binds identity separately
      accountVerified: false,
      mfaEnabled: false,
      revocationChecked: false,
      providerValidation: this.validationLevel(undefined),
    });

    return {
      valid: reasons.length === 0,
      serialNumber: normalized.serialNumber,
      subjectDN: normalized.subjectDN,
      issuerDN: normalized.issuerDN,
      notBefore: normalized.notBefore,
      notAfter: normalized.notAfter,
      email: normalized.email,
      signatureVerified,
      identityAssurance: assurance,
      reasons,
    };
  }

  // ------------------------------------------------------------- helpers ----
  /** Parses an end-entity PEM and extracts identity + validity (node-forge). */
  private parseCertificatePem(pem: string): NormalizedPem {
    let certificate: forge.pki.Certificate;
    try {
      certificate = forge.pki.certificateFromPem(pem);
    } catch {
      throw new BadRequestException('Invalid certificate PEM');
    }

    const serialNumber = certificate.serialNumber ?? 'unknown';
    const subjectDN = this.formatDn(certificate.subject.attributes);
    const issuerDN = this.formatDn(certificate.issuer.attributes);
    const email = this.extractEmail(certificate);
    const notBefore = new Date(certificate.validity.notBefore.toISOString());
    const notAfter = new Date(certificate.validity.notAfter.toISOString());
    if (!Number.isFinite(notBefore.getTime()) || !Number.isFinite(notAfter.getTime())) {
      throw new BadRequestException('Certificate validity dates are invalid');
    }
    if (notAfter < new Date()) {
      throw new BadRequestException('Cannot import an expired certificate');
    }
    return { serialNumber, subjectDN, issuerDN, notBefore, notAfter, email };
  }

  private extractEmail(certificate: forge.pki.Certificate): string | null {
    const san = certificate.extensions?.find((ext) => ext.name === 'subjectAltName');
    if (san && Array.isArray(san.altNames)) {
      const emailEntry = (san.altNames as Array<{ type?: number; value?: string }>).find(
        (entry) => entry.type === 1 && typeof entry.value === 'string', // GeneralName 1 = rfc822Name
      );
      if (emailEntry?.value) return emailEntry.value.toLowerCase();
    }
    const cn = this.cnFromSubject(this.formatDn(certificate.subject.attributes));
    return cn && cn.includes('@') ? cn.toLowerCase() : null;
  }

  private formatDn(dn: forge.pki.CertificateField[]): string {
    return dn.map((attr) => `${attr.name ?? attr.type}=${attr.value}`).join(', ');
  }

  private cnFromSubject(subjectDN: string): string | null {
    const cn = subjectDN.split(', ').find((part) => part.startsWith('CN='));
    return cn ? cn.slice(3) : null;
  }

  /** Proves the provided private key belongs to the certificate. */
  private assertPrivateKeyMatches(privateKeyPem: string, certificatePem: string): void {
    try {
      const privateKey = createPrivateKey(privateKeyPem);
      const publicKey = createPublicKey(certificatePem);
      const nonce = createHash('sha256').update(`${Date.now()}:signara`).digest();
      const signature = nodeSign('sha256', nonce, privateKey);
      const valid = nodeVerify('sha256', nonce, publicKey, signature);
      if (!valid) throw new Error('key mismatch');
    } catch {
      throw new BadRequestException('Private key does not match the certificate public key');
    }
  }

  private formatLabel(keyType: string): string {
    if (keyType === 'ec') return 'ECDSA-SHA256';
    if (keyType === 'ed25519') return 'Ed25519';
    return 'RSA-SHA256';
  }

  private hashName(keyType: string): string {
    return keyType === 'ed25519' ? 'ed25519' : 'sha256';
  }

  private validationLevel(raw: string | null | undefined): ProviderValidation {
    const level = raw?.toUpperCase();
    return level === 'DV' || level === 'OV' || level === 'EV' ? level : null;
  }

  private async signerHasMfa(userId?: string | null): Promise<boolean> {
    if (!userId) return false;
    const user = await this.prisma.user.findUnique({ where: { id: userId }, select: { mfaEnabled: true } });
    return user?.mfaEnabled ?? false;
  }

  private masterKey(): string {
    const key = this.config.get<string>('auth.cryptoMasterKey');
    if (!key) {
      throw new Error('CRYPTO_MASTER_KEY is not configured — required for private key material');
    }
    return key;
  }

  private sanitize<T extends { privateKeyEnc?: string | null }>(row: T): Omit<T, 'privateKeyEnc'> {
    const { privateKeyEnc: _privateKey, ...rest } = row;
    return rest;
  }
}