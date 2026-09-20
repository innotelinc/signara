import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { LOCALES } from './config';
import { translate, type Messages } from './translate';

/**
 * Guards the catalogs harvested from the retired OpenSign fork: every shipped
 * locale must parse and carry the keys the UI actually renders. A truncated or
 * hand-edited catalog fails here instead of silently falling back to English.
 */
const catalogDir = join(__dirname, '..', '..', '..', 'public', 'locales');

// Keys the app shell renders through `t(key, englishDefault)`.
const RENDERED_KEYS = [
  'sidebar.Dashboard',
  'sidebar.Documents',
  'sidebar.Templates',
  'sidebar.Settings',
  'log-out',
  'language',
];

function load(locale: string): Messages {
  return JSON.parse(readFileSync(join(catalogDir, locale, 'translation.json'), 'utf8')) as Messages;
}

describe('locale catalogs', () => {
  it.each(LOCALES.map((locale) => locale.code))('%s parses as a JSON object', (code) => {
    const catalog = load(code);
    expect(Object.keys(catalog).length).toBeGreaterThan(0);
  });

  it.each(LOCALES.map((locale) => locale.code))('%s translates every rendered key', (code) => {
    const catalog = load(code);
    for (const key of RENDERED_KEYS) {
      const value = translate(catalog, key, 'MISSING');
      expect(value).not.toBe('MISSING');
      expect(value.trim()).not.toHaveLength(0);
    }
  });

  it('translates the same surface differently per locale', () => {
    const en = load('en');
    const de = load('de');
    expect(translate(de, 'sidebar.Documents', 'Documents')).toBe('Dokumente');
    expect(translate(en, 'sidebar.Documents', 'Documents')).toBe('Documents');
    expect(translate(de, 'sidebar.Dashboard', 'Dashboard')).not.toBe('Dashboard');
  });

  it('falls back to the English default for a key no catalog has', () => {
    const de = load('de');
    expect(translate(de, 'signing.room.title', 'Ready to sign')).toBe('Ready to sign');
  });
});
