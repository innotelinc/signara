/**
 * Locale registry for the web app.
 *
 * The catalogs live in `public/locales/<code>/translation.json` so an operator
 * can add or edit a language without a rebuild. They are the OpenSign catalogs
 * harvested from the retired `sign` repo — see `apps/web/public/locales/README.md`
 * — which is why Korean keeps OpenSign's `kr` code instead of ISO `ko`.
 */
export const LOCALES = [
  { code: 'en', label: 'English' },
  { code: 'de', label: 'Deutsch' },
  { code: 'es', label: 'Español' },
  { code: 'fr', label: 'Français' },
  { code: 'it', label: 'Italiano' },
  { code: 'hi', label: 'हिन्दी' },
  { code: 'kr', label: '한국어' },
] as const;

export type Locale = (typeof LOCALES)[number]['code'];

export const DEFAULT_LOCALE: Locale = 'en';

/** Cookie the LocaleSwitcher writes; read back by the root layout. */
export const LOCALE_COOKIE = 'NEXT_LOCALE';

const CODES = new Set<string>(LOCALES.map((locale) => locale.code));

/** Browser tags we accept for a catalog that uses a different code. */
const ALIASES: Record<string, Locale> = { ko: 'kr' };

export function isLocale(value: string | null | undefined): value is Locale {
  return typeof value === 'string' && CODES.has(value);
}

/** Map an arbitrary BCP-47 tag (`de-AT`, `ko-KR`) onto a catalog code. */
export function normalizeLocale(tag: string | null | undefined): Locale | null {
  if (!tag) return null;
  const base = tag.trim().toLowerCase().split(/[-_]/)[0];
  if (!base || base === '*') return null;
  if (CODES.has(base)) return base as Locale;
  return ALIASES[base] ?? null;
}

/**
 * First supported locale in an `Accept-Language` header, honouring q-values.
 * Falls back to the default locale rather than returning null, so the layout
 * always has something to render.
 */
export function negotiateLocale(header: string | null | undefined): Locale {
  if (!header) return DEFAULT_LOCALE;

  const ranked = header
    .split(',')
    .map((part) => {
      const [tag, ...params] = part.split(';');
      const q = params
        .map((param) => param.trim())
        .find((param) => param.startsWith('q='))
        ?.slice(2);
      return { tag: tag?.trim() ?? '', q: q === undefined ? 1 : Number.parseFloat(q) };
    })
    .filter((entry) => entry.tag && Number.isFinite(entry.q) && entry.q > 0)
    .sort((a, b) => b.q - a.q);

  for (const { tag } of ranked) {
    const locale = normalizeLocale(tag);
    if (locale) return locale;
  }
  return DEFAULT_LOCALE;
}

/**
 * The locale to render this request in: an explicit cookie choice wins, then
 * the browser's preference list, then the default.
 */
export function resolveLocale(
  cookieValue: string | null | undefined,
  acceptLanguage: string | null | undefined,
): Locale {
  return normalizeLocale(cookieValue) ?? negotiateLocale(acceptLanguage);
}
