/**
 * Identity assurance scoring for certificate-backed signatures.
 *
 * The score is a transparent, documented 0–100 model built from independent
 * factors. It is stored on the Signature row (`identityAssurance`) and shown
 * in evidence reports so downstream consumers can reason about how strongly
 * the signer's identity was established.
 *
 *   certificateValid       cert is ACTIVE, unexpired, not revoked             +30
 *   certIdentityMatch      cert identity (email/user) matches the signer      +20
 *   accountVerified        signer is linked to a verified platform account    +15
 *   mfaEnabled             signer account enforces MFA at the IdP             +15
 *   revocationChecked      an external revocation check was performed         +10
 *   provider validation    DV +5 | OV +10 | EV +20  (only when cert valid)
 *
 * Levels: NONE < 25 · BASIC 25–49 · ADVANCED 50–79 · HIGH ≥ 80
 */
export type AssuranceLevel = 'NONE' | 'BASIC' | 'ADVANCED' | 'HIGH';

export type ProviderValidation = 'DV' | 'OV' | 'EV' | null;

export interface AssuranceFactors {
  certificateValid: boolean;
  certIdentityMatch: boolean;
  accountVerified: boolean;
  mfaEnabled: boolean;
  revocationChecked: boolean;
  providerValidation?: ProviderValidation;
}

export interface IdentityAssurance {
  score: number;
  level: AssuranceLevel;
  factors: AssuranceFactors;
}

const PROVIDER_VALIDATION_WEIGHT: Record<Exclude<ProviderValidation, null>, number> = {
  DV: 5,
  OV: 10,
  EV: 20,
};

export function computeIdentityAssurance(factors: AssuranceFactors): IdentityAssurance {
  let score = 0;
  if (factors.certificateValid) score += 30;
  if (factors.certIdentityMatch) score += 20;
  if (factors.accountVerified) score += 15;
  if (factors.mfaEnabled) score += 15;
  if (factors.revocationChecked) score += 10;
  if (factors.certificateValid && factors.providerValidation) {
    score += PROVIDER_VALIDATION_WEIGHT[factors.providerValidation] ?? 0;
  }

  const clamped = Math.min(100, score);
  const level: AssuranceLevel = clamped >= 80 ? 'HIGH' : clamped >= 50 ? 'ADVANCED' : clamped >= 25 ? 'BASIC' : 'NONE';
  return { score: clamped, level, factors };
}

/** Assurance for plain (non-certificate) signatures — used in evidence reports. */
export function unsignedAssurance(mfaEnabled: boolean, accountVerified: boolean): IdentityAssurance {
  return computeIdentityAssurance({
    certificateValid: false,
    certIdentityMatch: false,
    accountVerified,
    mfaEnabled,
    revocationChecked: false,
  });
}