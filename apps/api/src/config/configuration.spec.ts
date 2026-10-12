import configuration from './configuration';

/**
 * Regression coverage for buildCorsOrigins() (apps/api/src/config).
 *
 * The public signing room calls the API cross-origin, so the CORS allowlist
 * must cover every origin the web app is served from — WEB_URL, APP_URL, the
 * apex/parent domain of those hosts (https://app.signara.innotel.us is also
 * reachable as https://signara.innotel.us), and localhost during development.
 * A missing origin silently blocks the session fetch in the browser and the
 * signing room shows "Unable to open signing session".
 */

const ORIGIN_ENV_KEYS = ['WEB_URL', 'APP_URL', 'CORS_ORIGINS'] as const;

let saved: Record<string, string | undefined>;

beforeEach(() => {
  saved = {};
  for (const key of ORIGIN_ENV_KEYS) saved[key] = process.env[key];
});

afterEach(() => {
  for (const key of ORIGIN_ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

function origins(): string[] {
  return configuration().app.corsOrigins;
}

describe('SMTP transport options', () => {
  it('honours SMTP_TLS_INSECURE and stays off by default', () => {
    const saved = process.env.SMTP_TLS_INSECURE;
    try {
      delete process.env.SMTP_TLS_INSECURE;
      expect(configuration().smtp.tlsInsecure).toBe(false);
      process.env.SMTP_TLS_INSECURE = 'true';
      expect(configuration().smtp.tlsInsecure).toBe(true);
      // Only an explicit 'true' counts — a stray value must not disable
      // verification on a relay that does present a valid certificate.
      process.env.SMTP_TLS_INSECURE = '1';
      expect(configuration().smtp.tlsInsecure).toBe(false);
    } finally {
      if (saved === undefined) delete process.env.SMTP_TLS_INSECURE;
      else process.env.SMTP_TLS_INSECURE = saved;
    }
  });

  /**
   * SMTP_FROM is Alertmanager's sender, and product mail arriving from the
   * alerts mailbox is the wrong artefact under the right transport, so the
   * product identity has its own key. The envelope is separate again: a relay
   * that authenticates a mailbox refuses an envelope it did not authenticate.
   */
  it('gives the product its own sender and envelope, defaulting the envelope to the login', () => {
    const keys = ['SMTP_PRODUCT_FROM', 'SMTP_FROM', 'SMTP_ENVELOPE_FROM', 'SMTP_USER'] as const;
    const saved = keys.map((key) => [key, process.env[key]] as const);
    try {
      for (const key of keys) delete process.env[key];
      // Nothing set: the platform's own no-reply identity, and no envelope, so
      // nodemailer's default (the From address) applies.
      expect(configuration().smtp.from).toBe('Signara <no-reply@signara.innotel.us>');
      expect(configuration().smtp.envelopeFrom).toBe('');

      // A deployment that has only ever set SMTP_FROM keeps sending as it did
      // rather than from an address nobody authorised.
      process.env.SMTP_FROM = 'Signara Alerts <alertmanager@innotel.us>';
      expect(configuration().smtp.from).toBe('Signara Alerts <alertmanager@innotel.us>');

      // SMTP_PRODUCT_FROM wins, and the envelope follows the authenticated user
      // unless the deployment names a different authorised sender.
      process.env.SMTP_PRODUCT_FROM = 'Signara <no-reply@signara.innotel.us>';
      process.env.SMTP_USER = 'alertmanager@innotel.us';
      expect(configuration().smtp.from).toBe('Signara <no-reply@signara.innotel.us>');
      expect(configuration().smtp.envelopeFrom).toBe('alertmanager@innotel.us');

      process.env.SMTP_ENVELOPE_FROM = 'signing@innotel.us';
      expect(configuration().smtp.envelopeFrom).toBe('signing@innotel.us');
    } finally {
      for (const [key, value] of saved) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  it('reads the relay TLS name from SMTP_TLS_SERVERNAME, empty by default', () => {
    const saved = process.env.SMTP_TLS_SERVERNAME;
    try {
      delete process.env.SMTP_TLS_SERVERNAME;
      expect(configuration().smtp.tlsServername).toBe('');
      process.env.SMTP_TLS_SERVERNAME = 'innotel.us';
      expect(configuration().smtp.tlsServername).toBe('innotel.us');
    } finally {
      if (saved === undefined) delete process.env.SMTP_TLS_SERVERNAME;
      else process.env.SMTP_TLS_SERVERNAME = saved;
    }
  });
});

describe('CORS origin allowlist', () => {
  it('includes WEB_URL, its derived apex, and localhost dev origins by default', () => {
    delete process.env.WEB_URL;
    delete process.env.APP_URL;
    delete process.env.CORS_ORIGINS;

    const list = origins();
    expect(list).toContain('https://app.signara.innotel.us');
    expect(list).toContain('https://signara.innotel.us'); // apex of the web host
    expect(list).toContain('http://localhost:3000');
    expect(list).toContain('http://127.0.0.1:3000');
  });

  it('derives the apex from WEB_URL/APP_URL and deduplicates', () => {
    process.env.WEB_URL = 'https://app.signara.innotel.us';
    process.env.APP_URL = 'https://signara.innotel.us';
    delete process.env.CORS_ORIGINS;

    const list = origins();
    expect(list.filter((o) => o === 'https://signara.innotel.us')).toHaveLength(1);
    expect(list).toContain('https://app.signara.innotel.us');
  });

  it('does not synthesize an apex for bare localhost or IP hosts', () => {
    process.env.WEB_URL = 'http://localhost:3000';
    process.env.APP_URL = 'http://127.0.0.1:3000';
    delete process.env.CORS_ORIGINS;

    const list = origins();
    expect(list).toContain('http://localhost:3000');
    expect(list).toContain('http://127.0.0.1:3000');
    // No bogus apex like http://0.0.1 or http://3000 from an IP/bare host.
    expect(list).not.toContain('http://0.0.1');
    expect(list).not.toContain('http://3000');
  });

  it('appends CORS_ORIGINS entries, trimming whitespace and trailing slashes', () => {
    process.env.WEB_URL = 'https://app.signara.innotel.us';
    process.env.APP_URL = 'https://app.signara.innotel.us';
    process.env.CORS_ORIGINS = 'https://portal.signara.innotel.us,  https://signara.innotel.us/';

    const list = origins();
    expect(list).toContain('https://portal.signara.innotel.us');
    expect(list).toContain('https://signara.innotel.us'); // no trailing slash
    expect(list).not.toContain('https://signara.innotel.us/');
  });

  it('handles a comma-separated WEB_URL list (legacy multi-origin config)', () => {
    process.env.WEB_URL = 'https://app.signara.innotel.us, https://portal.signara.innotel.us';
    delete process.env.APP_URL;
    delete process.env.CORS_ORIGINS;

    const list = origins();
    expect(list).toContain('https://app.signara.innotel.us');
    expect(list).toContain('https://portal.signara.innotel.us');
    // Apex derived from both entries.
    expect(list).toContain('https://signara.innotel.us');
  });

  it('ignores empty entries', () => {
    process.env.WEB_URL = 'https://app.signara.innotel.us';
    process.env.APP_URL = 'https://app.signara.innotel.us';
    process.env.CORS_ORIGINS = ' ,, ';

    expect(origins()).not.toEqual([]);
  });
});
