import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { createHash, createPublicKey, sign as nodeSign } from 'node:crypto';
import * as forge from 'node-forge';
import { CertificatesService } from './certificates.service';
import { PrismaService } from '../../prisma/prisma.service';
import { ProviderRegistry } from './providers/provider-registry';
import { encryptSecret } from '../../common/crypto';

const MASTER_KEY = 'unit-test-master-key-0123456789abcdef0123456789abcdef';

/** Builds a throwaway self-signed certificate with an email SAN. */
function selfSigned(email: string): { certificatePem: string; privateKeyPem: string; serialNumber: string } {
  const keys = forge.pki.rsa.generateKeyPair(2048);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = `4d554e4954000000${Date.now().toString(16)}`;
  cert.validity.notBefore = new Date(Date.now() - 24 * 60 * 60 * 1000);
  cert.validity.notAfter = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000);
  cert.setSubject([{ name: 'commonName', value: email }, { name: 'emailAddress', value: email }]);
  cert.setIssuer([{ name: 'commonName', value: 'Signara Unit CA' }]);
  cert.setExtensions([{ name: 'subjectAltName', altNames: [{ type: 1, value: email }] }]);
  cert.sign(keys.privateKey, forge.md.sha256.create());
  return {
    certificatePem: forge.pki.certificateToPem(cert),
    privateKeyPem: forge.pki.privateKeyToPem(keys.privateKey),
    serialNumber: cert.serialNumber,
  };
}

describe('CertificatesService.signWithCertificate', () => {
  let service: CertificatesService;
  const { certificatePem, privateKeyPem, serialNumber } = selfSigned('ada@signara.test');

  const prismaMock = {
    signingCertificate: {
      findFirst: jest.fn(),
      findUnique: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
    },
    user: { findUnique: jest.fn().mockResolvedValue({ mfaEnabled: true }) },
  };

  const certificateRow = {
    id: 'cert-1',
    organizationId: 'org-1',
    userId: 'u-1',
    provider: 'INTERNAL_PKI',
    status: 'ACTIVE',
    commonName: 'ada@signara.test',
    email: 'ada@signara.test',
    serialNumber,
    subjectDN: 'CN=ada@signara.test, EMAILADDRESS=ada@signara.test',
    issuerDN: 'CN=Signara Unit CA',
    notBefore: new Date(Date.now() - 24 * 60 * 60 * 1000),
    notAfter: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000),
    certificatePem,
    chainPem: null,
    privateKeyEnc: encryptSecret(privateKeyPem, MASTER_KEY),
    validationLevel: 'OV',
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    const moduleRef = await Test.createTestingModule({
      providers: [
        CertificatesService,
        { provide: PrismaService, useValue: prismaMock },
        { provide: ConfigService, useValue: { get: (key: string) => (key === 'auth.cryptoMasterKey' ? MASTER_KEY : undefined) } },
        { provide: ProviderRegistry, useValue: { get: jest.fn(), status: jest.fn().mockReturnValue([]) } },
      ],
    }).compile();
    service = moduleRef.get(CertificatesService);
  });

  const base = {
    organizationId: 'org-1',
    certificateId: 'cert-1',
    signerUserId: 'u-1',
    signerEmail: 'ada@signara.test',
    contentHash: createHash('sha256').update('document-bytes').digest('hex'),
  };

  it('produces a server-side signature that verifies against the certificate', async () => {
    prismaMock.signingCertificate.findFirst.mockResolvedValue(certificateRow);

    const evidence = await service.signWithCertificate(base);

    expect(evidence.certificateId).toBe('cert-1');
    expect(evidence.serialNumber).toBe(serialNumber);
    expect(evidence.signatureFormat).toMatch(/RSA|ECDSA/);
    const valid = await import('node:crypto').then(({ verify }) =>
      verify('sha256', Buffer.from(base.contentHash, 'hex'), createPublicKey(certificatePem), Buffer.from(evidence.signatureValue, 'base64')),
    );
    expect(valid).toBe(true);
  });

  it('accepts a provider-produced signature after verifying it', async () => {
    prismaMock.signingCertificate.findFirst.mockResolvedValue(certificateRow);
    const providerSignature = nodeSign('sha256', Buffer.from(base.contentHash, 'hex'), privateKeyPem).toString('base64');

    const evidence = await service.signWithCertificate({ ...base, providedSignature: providerSignature });
    expect(evidence.signatureValue).toBe(providerSignature);
    expect(evidence.identityAssurance.level).toBe('HIGH'); // valid+match+account+mfa+OV
  });

  it('rejects a signature that does not verify', async () => {
    prismaMock.signingCertificate.findFirst.mockResolvedValue(certificateRow);
    await expect(
      service.signWithCertificate({ ...base, providedSignature: Buffer.from('garbage').toString('base64') }),
    ).rejects.toThrow('does not verify');
  });

  it('rejects an expired certificate', async () => {
    prismaMock.signingCertificate.findFirst.mockResolvedValue({
      ...certificateRow,
      notAfter: new Date(Date.now() - 60_000),
    });
    await expect(service.signWithCertificate(base)).rejects.toThrow('expired');
  });

  it('rejects a revoked certificate', async () => {
    prismaMock.signingCertificate.findFirst.mockResolvedValue({
      ...certificateRow,
      status: 'REVOKED',
      revokedAt: new Date(),
    });
    await expect(service.signWithCertificate(base)).rejects.toThrow('not active');
  });

  it('rejects when the certificate identity does not match the signer', async () => {
    prismaMock.signingCertificate.findFirst.mockResolvedValue(certificateRow);
    await expect(
      service.signWithCertificate({ ...base, signerUserId: null, signerEmail: 'eve@signara.test' }),
    ).rejects.toThrow('does not match');
  });

  it('imports a certificate, extracts identity, and stores the key encrypted', async () => {
    prismaMock.signingCertificate.findUnique.mockResolvedValue(null);
    prismaMock.signingCertificate.create.mockResolvedValue({
      ...certificateRow,
      id: 'cert-2',
      privateKeyEnc: encryptSecret(privateKeyPem, MASTER_KEY),
    });

    const user = {
      id: 'u-1',
      email: 'ada@signara.test',
      displayName: 'Ada',
      platformRole: 'USER' as const,
      sub: 'sub-1',
      groups: [],
      org: { id: 'org-1', slug: 'acme', role: 'OWNER', permissions: [] },
    };
    const result = await service.importCertificate(user, {
      certificatePem,
      privateKeyPem,
      provider: 'INTERNAL_PKI',
      validationLevel: 'OV',
    });

    const createCall = prismaMock.signingCertificate.create.mock.calls[0][0].data;
    expect(createCall.email).toBe('ada@signara.test');
    expect(createCall.privateKeyEnc).toMatch(/^enc:v1:/);
    // forge normalizes the serial number to even-length hex
    const parsedSerial = forge.pki.certificateFromPem(certificatePem).serialNumber;
    expect(createCall.serialNumber).toBe(parsedSerial);
    expect(result).not.toHaveProperty('privateKeyEnc'); // sanitized at rest
  });
});