/**
 * Refuses to boot on the placeholder secrets that ship in `.env.example`.
 *
 * The deployment ran for weeks on the published defaults — `POSTGRES_PASSWORD`,
 * `JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET`, `CRYPTO_MASTER_KEY`, `S3_SECRET_KEY`
 * and `MEILISEARCH_API_KEY` were all still `change-me-*`, and the two Authentik
 * secrets were absent entirely — and **nothing failed loudly**. Postgres accepts
 * a known password, the API signs tokens with a key that is in a public
 * repository, and stored private key material is encrypted with a master key
 * anyone with the repo can read.
 *
 * `configuration.ts` is not the place to catch it: that module defaults a
 * *missing* value, and `change-me-…` is a perfectly well-formed string.
 * `setup.sh --production` guarded the same list, but only at install time — a
 * deployment created by copying `.env.example` and running `docker compose up`
 * never runs it. So the check lives where the consequence does: the process
 * that signs tokens and decrypts stored key material.
 *
 * Development is left alone deliberately: a placeholder is not a security
 * posture worth blocking a laptop on, and `setup.sh` generates real values
 * anyway.
 */

// Matches `change-me`, `changeme` and `change_me` **anywhere** in the value,
// not just at the start: DATABASE_URL and REDIS_URL carry the password mid-
// string (`postgresql://signara:change-me-postgres@postgres:5432/…`), which a
// prefix rule would miss — and that URL is exactly how the shipping password
// reached the deployment. A real generated secret (hex, base64) cannot contain
// this substring, so the broad match costs nothing.
const PLACEHOLDER = /change[-_.]?me/i;

/** Empty is fatal in production — there is no safe default for these. */
const REQUIRED_IN_PRODUCTION = [
  'JWT_ACCESS_SECRET',
  'JWT_REFRESH_SECRET',
  'CRYPTO_MASTER_KEY',
] as const;

/**
 * Watched for a shipped placeholder. An unset key is *not* an error here (most
 * are optional), but a placeholder one never is: it means `.env.example` was
 * copied and never filled in.
 */
const NO_PLACEHOLDERS = [
  ...REQUIRED_IN_PRODUCTION,
  'POSTGRES_PASSWORD',
  'REDIS_PASSWORD',
  'DATABASE_URL',
  'REDIS_URL',
  'S3_SECRET_KEY',
  'MEILISEARCH_API_KEY',
  'OIDC_CLIENT_SECRET',
  'AUTHENTIK_SECRET_KEY',
  'AUTHENTIK_DB_PASSWORD',
  'AUTHENTIK_BOOTSTRAP_PASSWORD',
] as const;

export class PlaceholderSecretError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PlaceholderSecretError';
  }
}

/** True when the value is one of the placeholders `.env.example` ships. */
export function isPlaceholder(value: string | undefined | null): boolean {
  return PLACEHOLDER.test((value ?? '').trim());
}

/**
 * Throws when `NODE_ENV=production` and the environment is not fit to run:
 * a required secret is empty, or any watched key still holds a shipped
 * placeholder. Returns silently in every other case.
 */
export function assertSecretPosture(env: NodeJS.ProcessEnv = process.env): void {
  if ((env.NODE_ENV ?? 'development') !== 'production') return;

  const problems: string[] = [];
  for (const key of REQUIRED_IN_PRODUCTION) {
    if (!(env[key] ?? '').trim()) problems.push(`${key} is not set`);
  }
  for (const key of NO_PLACEHOLDERS) {
    if (isPlaceholder(env[key])) problems.push(`${key} still holds the placeholder from .env.example`);
  }
  if (problems.length === 0) return;

  throw new PlaceholderSecretError(
    [
      'Refusing to start: this deployment would run with default credentials.',
      ...problems.map((problem) => `  - ${problem}`),
      '',
      'Generate real values (`./setup.sh` does it for a new .env), store them in',
      'Cerulean Vault (`python3 scripts/vault-migrate.py --from-env-file .env`), and',
      'keep the resolved values in the gitignored .env — see docs/stack.md.',
    ].join('\n'),
  );
}
