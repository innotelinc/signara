export type ProviderKind = 'CERULEAN' | 'ACME' | 'INTERNAL_PKI';

export interface CertificateProvisionInput {
  organizationId: string;
  /** Subject common name (for person certificates this is the signer email). */
  commonName: string;
  email?: string;
  /** Provider-specific options (ACME dns-01 credentials, Cerulean template, ...). */
  options?: Record<string, unknown>;
}

/**
 * Raw issuance result. The certificates service normalizes the PEMs
 * (serial, subject, validity, SAN email extraction) with node-forge before
 * persistence, so providers may leave parsed fields unset.
 */
export interface IssuedCertificate {
  /** End-entity certificate in PEM (DER base64). */
  certificatePem: string;
  /** Intermediate/root chain in PEM order (issuer(s) first). */
  chainPem?: string;
  /** Private key PEM — MUST be encrypted at rest by the caller. */
  privateKeyPem?: string;
  keyAlgorithm?: string;
  validationLevel?: string;
  /** External identifier returned by the provider. */
  sourceRef?: string;
}

export interface CertificateProvider {
  readonly kind: ProviderKind;
  /** Whether the deployment has configured this provider (env + credentials). */
  isConfigured(): boolean;
  provision(input: CertificateProvisionInput): Promise<IssuedCertificate>;
}