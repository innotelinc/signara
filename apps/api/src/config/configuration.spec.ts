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
