import {
  DEFAULT_LOCALE,
  isLocale,
  negotiateLocale,
  normalizeLocale,
  resolveLocale,
} from './config';
import { interpolate, lookup, translate } from './translate';

describe('lookup', () => {
  const messages = {
    'log-out': 'Log Out',
    sidebar: { Dashboard: 'Armaturenbrett', Settings: 'Einstellungen' },
  };

  it('reads flat keys', () => {
    expect(lookup(messages, 'log-out')).toBe('Log Out');
  });

  it('reads dot-path keys', () => {
    expect(lookup(messages, 'sidebar.Dashboard')).toBe('Armaturenbrett');
  });

  it('returns undefined for a missing key', () => {
    expect(lookup(messages, 'sidebar.Nope')).toBeUndefined();
  });

  it('returns undefined when the path stops on a group', () => {
    expect(lookup(messages, 'sidebar')).toBeUndefined();
  });

  it('survives a null catalog', () => {
    expect(lookup(null, 'log-out')).toBeUndefined();
  });

  it('does not walk into a scalar', () => {
    expect(lookup(messages, 'log-out.deeper')).toBeUndefined();
  });
});

describe('interpolate', () => {
  it('substitutes named variables', () => {
    expect(interpolate('{{count}} documents', { count: 3 })).toBe('3 documents');
  });

  it('tolerates surrounding whitespace in the placeholder', () => {
    expect(interpolate('{{ appName }} Drive', { appName: 'Signara' })).toBe('Signara Drive');
  });

  it('leaves an unresolved placeholder visible', () => {
    expect(interpolate('{{count}} documents', {})).toBe('{{count}} documents');
  });

  it('is a no-op without variables', () => {
    expect(interpolate('{{count}} documents')).toBe('{{count}} documents');
  });
});

describe('translate', () => {
  const messages = { sidebar: { Dashboard: 'Armaturenbrett' } };

  it('prefers the catalog value', () => {
    expect(translate(messages, 'sidebar.Dashboard', 'Dashboard')).toBe('Armaturenbrett');
  });

  it('falls back to the English default for an untranslated key', () => {
    expect(translate(messages, 'sidebar.Documents', 'Documents')).toBe('Documents');
  });

  it('falls back to the key when there is no default', () => {
    expect(translate(messages, 'sidebar.Documents')).toBe('sidebar.Documents');
  });

  it('interpolates the catalog value', () => {
    expect(translate({ greeting: 'Hi {{name}}' }, 'greeting', 'Hi', { name: 'Ada' })).toBe(
      'Hi Ada',
    );
  });

  it('reads correctly with no catalog at all', () => {
    expect(translate({}, 'sidebar.Templates', 'Templates')).toBe('Templates');
  });
});

describe('normalizeLocale', () => {
  it('accepts a supported code', () => {
    expect(normalizeLocale('de')).toBe('de');
  });

  it('reduces a regional tag to its base language', () => {
    expect(normalizeLocale('fr-CA')).toBe('fr');
  });

  it('maps the ISO Korean code onto the harvested `kr` catalog', () => {
    expect(normalizeLocale('ko-KR')).toBe('kr');
  });

  it('rejects an unsupported language', () => {
    expect(normalizeLocale('pt-BR')).toBeNull();
  });

  it('ignores the wildcard', () => {
    expect(normalizeLocale('*')).toBeNull();
  });

  it('ignores empty input', () => {
    expect(normalizeLocale(null)).toBeNull();
  });
});

describe('negotiateLocale', () => {
  it('picks the highest-weighted supported language', () => {
    expect(negotiateLocale('pt-BR,de;q=0.9,en;q=0.8')).toBe('de');
  });

  it('honours q-values rather than header order', () => {
    expect(negotiateLocale('en;q=0.5,fr;q=0.9')).toBe('fr');
  });

  it('skips languages we do not ship', () => {
    expect(negotiateLocale('pt-BR,ja')).toBe(DEFAULT_LOCALE);
  });

  it('skips a zero-weight language', () => {
    expect(negotiateLocale('de;q=0,it')).toBe('it');
  });

  it('falls back when the header is absent', () => {
    expect(negotiateLocale(null)).toBe(DEFAULT_LOCALE);
  });
});

describe('resolveLocale', () => {
  it('prefers the stored cookie over the browser header', () => {
    expect(resolveLocale('es', 'de-DE,de;q=0.9')).toBe('es');
  });

  it('uses the header when no cookie is set', () => {
    expect(resolveLocale(undefined, 'de-DE,de;q=0.9')).toBe('de');
  });

  it('ignores an unsupported cookie and falls through to the header', () => {
    expect(resolveLocale('xx', 'it-IT')).toBe('it');
  });

  it('defaults when neither input is usable', () => {
    expect(resolveLocale(null, null)).toBe(DEFAULT_LOCALE);
  });
});

describe('isLocale', () => {
  it('narrows a known code', () => {
    expect(isLocale('kr')).toBe(true);
  });

  it('rejects anything else', () => {
    expect(isLocale('xx')).toBe(false);
    expect(isLocale(undefined)).toBe(false);
  });
});
