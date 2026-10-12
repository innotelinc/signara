import { PlaceholderSecretError, assertSecretPosture, isPlaceholder } from './secret-posture';

/**
 * Regression coverage for the production secret posture (apps/api/src/config).
 *
 * The deployment ran on the placeholders `.env.example` ships for weeks without
 * a single error, so this guard is what keeps that from being *silent* if it
 * ever happens again. The two cases that matter are the ones the old
 * `setup.sh`-only check missed: a password carried inside DATABASE_URL, and a
 * placeholder that is a well-formed string rather than a missing value.
 */

const REAL = {
  JWT_ACCESS_SECRET: 'a'.repeat(72),
  JWT_REFRESH_SECRET: 'b'.repeat(72),
  CRYPTO_MASTER_KEY: 'c'.repeat(64),
  POSTGRES_PASSWORD: 'd'.repeat(48),
  REDIS_PASSWORD: 'e'.repeat(48),
  DATABASE_URL: `postgresql://signara:${'d'.repeat(48)}@postgres:5432/signara?schema=public`,
  REDIS_URL: `redis://:${'e'.repeat(48)}@redis:6379`,
  S3_SECRET_KEY: 'f'.repeat(48),
  MEILISEARCH_API_KEY: 'g'.repeat(48),
  OIDC_CLIENT_SECRET: 'h'.repeat(43),
  AUTHENTIK_SECRET_KEY: 'i'.repeat(96),
  AUTHENTIK_DB_PASSWORD: 'j'.repeat(48),
  AUTHENTIK_BOOTSTRAP_PASSWORD: 'k'.repeat(48),
} as NodeJS.ProcessEnv;

describe('isPlaceholder', () => {
  it('recognises the shapes .env.example ships', () => {
    expect(isPlaceholder('change-me-postgres')).toBe(true);
    expect(isPlaceholder('change-me')).toBe(true);
    expect(isPlaceholder('changeme')).toBe(true);
    expect(isPlaceholder('change_me-32-byte-master-key-0000000000')).toBe(true);
  });

  it('recognises one carried mid-string, inside a URL', () => {
    expect(isPlaceholder('postgresql://signara:change-me-postgres@postgres:5432/signara')).toBe(true);
    expect(isPlaceholder('redis://:change-me-redis@redis:6379')).toBe(true);
  });

  it('leaves real secrets and unset values alone', () => {
    expect(isPlaceholder(REAL.CRYPTO_MASTER_KEY)).toBe(false);
    expect(isPlaceholder('')).toBe(false);
    expect(isPlaceholder(undefined)).toBe(false);
  });
});

describe('assertSecretPosture', () => {
  it('accepts a fully generated production environment', () => {
    expect(() => assertSecretPosture({ NODE_ENV: 'production', ...REAL })).not.toThrow();
  });

  it('refuses a placeholder DB password carried inside DATABASE_URL', () => {
    expect(() =>
      assertSecretPosture({
        NODE_ENV: 'production',
        ...REAL,
        DATABASE_URL: 'postgresql://signara:change-me-postgres@postgres:5432/signara',
      }),
    ).toThrow(/DATABASE_URL/);
  });

  it('names every placeholder it finds', () => {
    let error: unknown;
    try {
      assertSecretPosture({
        NODE_ENV: 'production',
        ...REAL,
        CRYPTO_MASTER_KEY: 'change-me-32-byte-master-key-0000000000',
        JWT_ACCESS_SECRET: 'change-me-jwt-access-secret',
      });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(PlaceholderSecretError);
    const message = (error as Error).message;
    expect(message).toContain('CRYPTO_MASTER_KEY');
    expect(message).toContain('JWT_ACCESS_SECRET');
    expect(message).not.toContain('REDIS_PASSWORD'); // a real value stays out of the report
  });

  it('refuses a missing required secret, which has no safe default', () => {
    expect(() =>
      assertSecretPosture({ NODE_ENV: 'production', ...REAL, CRYPTO_MASTER_KEY: '' }),
    ).toThrow(/CRYPTO_MASTER_KEY is not set/);
  });

  it('tolerates optional keys that are simply unset', () => {
    const { AUTHENTIK_SECRET_KEY: _a, OIDC_CLIENT_SECRET: _o, ...withoutOptional } = REAL;
    expect(() => assertSecretPosture({ NODE_ENV: 'production', ...withoutOptional })).not.toThrow();
  });

  it('does not police development, where setup.sh generates real values anyway', () => {
    expect(() =>
      assertSecretPosture({ NODE_ENV: 'development', CRYPTO_MASTER_KEY: 'change-me-32-byte' }),
    ).not.toThrow();
    expect(() => assertSecretPosture({ CRYPTO_MASTER_KEY: 'change-me-32-byte' })).not.toThrow();
  });
});
