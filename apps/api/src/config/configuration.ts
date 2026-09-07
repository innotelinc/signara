export default () => ({
  env: process.env.NODE_ENV ?? 'development',
  app: {
    name: process.env.APP_NAME ?? 'Signara',
    url: process.env.APP_URL ?? 'https://app.signara.innotel.us',
    apiUrl: process.env.API_URL ?? 'https://api.signara.innotel.us',
    webUrl: process.env.WEB_URL ?? 'https://app.signara.innotel.us',
    authUrl: process.env.AUTH_URL ?? 'https://auth.signara.innotel.us',
    port: Number(process.env.API_PORT ?? 8000),
    // Origins the browser is allowed to call the API from. Derived from the
    // web/app URLs (including the apex/parent domain the app is often also
    // served from) plus localhost for local development. CORS_ORIGINS, when
    // set, adds extra comma-separated origins on top of the derived list.
    corsOrigins: buildCorsOrigins(
      process.env.CORS_ORIGINS,
      process.env.WEB_URL ?? 'https://app.signara.innotel.us',
      process.env.APP_URL ?? 'https://app.signara.innotel.us',
    ),
  },
  database: {
    url: process.env.DATABASE_URL ?? 'postgresql://signara:signara@localhost:5432/signara?schema=public',
  },
  redis: {
    url: process.env.REDIS_URL ?? 'redis://localhost:6379',
  },
  s3: {
    endpoint: process.env.S3_ENDPOINT ?? 'http://localhost:9000',
    region: process.env.S3_REGION ?? 'us-east-1',
    bucket: process.env.S3_BUCKET ?? 'signara-documents',
    accessKey: process.env.S3_ACCESS_KEY ?? '',
    secretKey: process.env.S3_SECRET_KEY ?? '',
    forcePathStyle: process.env.S3_FORCE_PATH_STYLE !== 'false',
    // Public-facing S3 origin (e.g. https://storage.signara.innotel.us) used
    // to generate presigned URLs browsers can actually reach. Falls back to
    // `endpoint` when unset.
    publicEndpoint: process.env.S3_PUBLIC_ENDPOINT ?? '',
  },
  meilisearch: {
    host: process.env.MEILISEARCH_HOST ?? 'http://localhost:7700',
    apiKey: process.env.MEILISEARCH_API_KEY ?? '',
  },
  oidc: {
    issuerUrl: process.env.OIDC_ISSUER_URL ?? '',
    clientId: process.env.OIDC_CLIENT_ID ?? '',
    clientSecret: process.env.OIDC_CLIENT_SECRET ?? '',
    jwksUrl: process.env.OIDC_JWKS_URL ?? '',
    redirectUri: process.env.OIDC_REDIRECT_URI ?? '',
    authorizationUrl: process.env.OIDC_AUTHORIZATION_URL ?? '',
    tokenUrl: process.env.OIDC_TOKEN_URL ?? '',
    userinfoUrl: process.env.OIDC_USERINFO_URL ?? '',
    scopes: (process.env.OIDC_SCOPES ?? 'openid profile email groups').split(' '),
    idpAdminGroup: process.env.IDP_ADMIN_GROUP ?? 'signara-admins',
  },
  auth: {
    jwtAccessSecret: process.env.JWT_ACCESS_SECRET ?? '',
    jwtAccessTtl: process.env.JWT_ACCESS_TTL ?? '15m',
    jwtRefreshSecret: process.env.JWT_REFRESH_SECRET ?? '',
    jwtRefreshTtl: process.env.JWT_REFRESH_TTL ?? '30d',
    cryptoMasterKey: process.env.CRYPTO_MASTER_KEY ?? '',
    cookieSecure: process.env.SESSION_COOKIE_SECURE === 'true',
    // Shared cookie domain so the httpOnly session cookies set by the API
    // (api.<domain>) are also visible to the web app (app.<domain>). Auto-
    // derived from API_URL when not set explicitly; empty for bare hosts/IPs.
    cookieDomain:
      process.env.COOKIE_DOMAIN ??
      deriveCookieDomain(process.env.API_URL ?? 'https://api.signara.innotel.us'),
  },
  certificates: {
    acmeDirectoryUrl: process.env.ACME_DIRECTORY_URL ?? '',
    acmeContactEmail: process.env.ACME_CONTACT_EMAIL ?? '',
    acmeDnsProvider: process.env.ACME_DNS_PROVIDER ?? '',
    acmeHttpChallenge: process.env.ACME_HTTP_CHALLENGE === 'true',
    ceruleanApiUrl: process.env.CERULEAN_API_URL ?? 'https://api.cerulean.com/v1',
    ceruleanApiKey: process.env.CERULEAN_API_KEY ?? '',
    internalPkiScript: process.env.INTERNAL_PKI_PROVISION_SCRIPT ?? '',
    cloudflareApiToken: process.env.CF_API_TOKEN ?? '',
  },
  rateLimit: {
    windowMs: Number(process.env.RATE_LIMIT_WINDOW_MS ?? 60_000),
    max: Number(process.env.RATE_LIMIT_MAX ?? 100),
  },
  billing: {
    enabled: process.env.BILLING_ENABLED === 'true',
    stripeSecretKey: process.env.STRIPE_SECRET_KEY ?? '',
    stripeWebhookSecret: process.env.STRIPE_WEBHOOK_SECRET ?? '',
  },
  smtp: {
    host: process.env.SMTP_HOST ?? '',
    port: Number(process.env.SMTP_PORT ?? 587),
    secure: process.env.SMTP_SECURE, // 'true' = implicit TLS (SMTPS); unset → port 465 implies TLS
    user: process.env.SMTP_USER ?? '',
    pass: process.env.SMTP_PASS ?? '',
    from: process.env.SMTP_FROM ?? 'Signara <no-reply@signara.innotel.us>',
  },
  monitoring: {
    otelEndpoint: process.env.OTEL_EXPORTER_OTLP_ENDPOINT ?? '',
    sentryDsn: process.env.SENTRY_DSN ?? '',
  },
});

/**
 * Derives the cookie domain from the API host so the web app (a sibling
 * subdomain, e.g. app.signara.innotel.us) receives the session cookies the
 * API sets. Returns '' when the host is localhost, an IP, or a bare single-
 * label host (no shared parent domain to pin).
 */
function deriveCookieDomain(apiUrl: string): string {
  try {
    const host = new URL(apiUrl).hostname;
    const labels = host.split('.');
    // Two labels → already the registrable domain (e.g. example.com); three or
    // more → strip the service subdomain (api. → .signara.innotel.us).
    if (labels.length < 2) return '';
    if (labels.length === 2) return `.${host}`;
    return `.${labels.slice(1).join('.')}`;
  } catch {
    return '';
  }
}

/**
 * Builds the CORS origin allowlist.
 *
 * The web app is served from WEB_URL/APP_URL (e.g. app.signara.innotel.us)
 * but is commonly also reachable at the apex/parent domain of those hosts
 * (https://signara.innotel.us) and at localhost:3000 during development.
 * Requests from any of those origins would be silently blocked by the browser
 * without an allowlisted origin, so all of them are included.
 *
 * `extra` (CORS_ORIGINS) appends operator-defined origins on top of the
 * derived list.
 */
function buildCorsOrigins(extra: string | undefined, webUrl: string, appUrl: string): string[] {
  const origins = new Set<string>();

  const add = (url: string | undefined) => {
    if (!url) return;
    // WEB_URL/APP_URL may themselves hold a comma-separated list of origins.
    for (const entry of url.split(',')) {
      const normalized = entry.trim().replace(/\/$/, '');
      if (!normalized) continue;
      origins.add(normalized);
      const apex = deriveApexOrigin(normalized);
      if (apex) origins.add(apex);
    }
  };

  add(webUrl);
  add(appUrl);
  // Local development: the dev web server on :3000 talking to a local API.
  origins.add('http://localhost:3000');
  origins.add('http://127.0.0.1:3000');

  for (const origin of (extra ?? '').split(',')) {
    const trimmed = origin.trim().replace(/\/$/, '');
    if (trimmed) origins.add(trimmed);
  }

  return [...origins].filter(Boolean);
}

/**
 * Returns the parent-domain origin of a URL (https://app.example.com →
 * https://example.com), or null when the host is already a registrable domain
 * (two labels), a bare host, or an IP address.
 */
function deriveApexOrigin(url: string): string | null {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname;
    // Skip IP addresses and IPv6 literals — they have no meaningful apex.
    if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(':')) return null;
    const labels = host.split('.');
    if (labels.length < 3) return null;
    return `${parsed.protocol}//${labels.slice(1).join('.')}${parsed.port ? `:${parsed.port}` : ''}`;
  } catch {
    return null;
  }
}
