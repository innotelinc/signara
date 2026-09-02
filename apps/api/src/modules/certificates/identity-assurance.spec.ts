import { computeIdentityAssurance, unsignedAssurance } from './identity-assurance';

describe('computeIdentityAssurance', () => {
  it('scores NONE for an unsigned signature (no certificate factors)', () => {
    const result = computeIdentityAssurance({
      certificateValid: false,
      certIdentityMatch: false,
      accountVerified: false,
      mfaEnabled: false,
      revocationChecked: false,
    });
    expect(result.score).toBe(0);
    expect(result.level).toBe('NONE');
  });

  it('caps at 100 with every factor plus EV validation', () => {
    const result = computeIdentityAssurance({
      certificateValid: true,
      certIdentityMatch: true,
      accountVerified: true,
      mfaEnabled: true,
      revocationChecked: true,
      providerValidation: 'EV',
    });
    expect(result.score).toBe(100);
    expect(result.level).toBe('HIGH');
  });

  it('maps 50–79 to ADVANCED (valid cert + matching identity)', () => {
    const result = computeIdentityAssurance({
      certificateValid: true,
      certIdentityMatch: true,
      accountVerified: false,
      mfaEnabled: false,
      revocationChecked: false,
    });
    expect(result.score).toBe(50);
    expect(result.level).toBe('ADVANCED');
  });

  it('maps 25–49 to BASIC', () => {
    const result = computeIdentityAssurance({
      certificateValid: true,
      certIdentityMatch: false,
      accountVerified: false,
      mfaEnabled: false,
      revocationChecked: false,
    });
    expect(result.score).toBe(30);
    expect(result.level).toBe('BASIC');
  });

  it('differentiates DV/OV/EV validation weight', () => {
    const base = {
      certificateValid: true,
      certIdentityMatch: true,
      accountVerified: true,
      mfaEnabled: true,
      revocationChecked: false,
    };
    expect(computeIdentityAssurance({ ...base, providerValidation: 'DV' }).score).toBe(85);
    expect(computeIdentityAssurance({ ...base, providerValidation: 'OV' }).score).toBe(90);
    expect(computeIdentityAssurance({ ...base, providerValidation: 'EV' }).score).toBe(100);
  });

  it('reports factors for evidence transparency', () => {
    const result = computeIdentityAssurance({
      certificateValid: true,
      certIdentityMatch: true,
      accountVerified: true,
      mfaEnabled: false,
      revocationChecked: false,
      providerValidation: 'OV',
    });
    expect(result.factors).toEqual({
      certificateValid: true,
      certIdentityMatch: true,
      accountVerified: true,
      mfaEnabled: false,
      revocationChecked: false,
      providerValidation: 'OV',
    });
  });

  it('provides the unsigned baseline used for typed signatures', () => {
    expect(unsignedAssurance(true, true).score).toBe(30);
    expect(unsignedAssurance(true, true).level).toBe('BASIC');
  });
});