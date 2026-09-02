-- ==========================================================================
-- Signara — certificate-backed signing
-- Adds SigningCertificate (provider-managed certificates for advanced
-- signatures) and extends Signature with the cryptographic evidence fields.
-- ==========================================================================

-- ---------------------------------------------------------------- enums ---
CREATE TYPE "CertificateProvider" AS ENUM ('CERULEAN', 'ACME', 'INTERNAL_PKI', 'WEB');
CREATE TYPE "CertificateStatus" AS ENUM ('ACTIVE', 'REVOKED', 'EXPIRED');

-- ------------------------------------------------------------ certificates --
CREATE TABLE "SigningCertificate" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "userId" TEXT,
    "provider" "CertificateProvider" NOT NULL DEFAULT 'INTERNAL_PKI',
    "status" "CertificateStatus" NOT NULL DEFAULT 'ACTIVE',
    "commonName" TEXT NOT NULL,
    "email" TEXT,
    "serialNumber" TEXT NOT NULL,
    "subjectDN" TEXT NOT NULL,
    "issuerDN" TEXT,
    "notBefore" TIMESTAMP(3) NOT NULL,
    "notAfter" TIMESTAMP(3) NOT NULL,
    "certificatePem" TEXT NOT NULL,
    "chainPem" TEXT,
    "privateKeyEnc" TEXT,
    "keyAlgorithm" TEXT,
    "validationLevel" TEXT,
    "certificateRequestId" TEXT,
    "sourceRef" TEXT,
    "metadata" JSONB,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "revokedReason" TEXT,

    CONSTRAINT "SigningCertificate_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "SigningCertificate_notAfter_check" CHECK ("notAfter" > "notBefore")
);

-- Extend Signature with the certificate evidence
ALTER TABLE "Signature"
    ADD COLUMN "certificateId" TEXT,
    ADD COLUMN "signatureValue" TEXT,
    ADD COLUMN "signatureFormat" TEXT,
    ADD COLUMN "identityAssurance" JSONB;

-- ---------------------------------------------------------- foreign keys ---
ALTER TABLE "SigningCertificate" ADD CONSTRAINT "SigningCertificate_organizationId_fkey"
    FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SigningCertificate" ADD CONSTRAINT "SigningCertificate_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "Signature" ADD CONSTRAINT "Signature_certificateId_fkey"
    FOREIGN KEY ("certificateId") REFERENCES "SigningCertificate"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ---------------------------------------------------------------- indexes ---
CREATE UNIQUE INDEX "SigningCertificate_organizationId_serialNumber_key"
    ON "SigningCertificate"("organizationId", "serialNumber");
CREATE INDEX "SigningCertificate_organizationId_status_idx"
    ON "SigningCertificate"("organizationId", "status");
CREATE INDEX "SigningCertificate_status_notAfter_idx"
    ON "SigningCertificate"("status", "notAfter");
CREATE INDEX "Signature_certificateId_idx" ON "Signature"("certificateId");