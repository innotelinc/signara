# i18n runtime

Dependency-free translation for the web app: it loads a catalog per locale and
resolves keys in the order **catalog → inline English default → key**.

## Why not a library

There was no i18n dependency to reuse, and the requirement is narrow — render the
harvested catalogs (see `apps/web/public/locales/README.md`) for the locales we
ship, with correct server rendering for a stored locale. That is roughly 60 lines.
If locale _routing_ (`/de/documents`) is ever needed, replace this module with
`next-intl` rather than growing it — the call sites only depend on `t()`.

## Files

| File                                    | Role                                                                                      |
| --------------------------------------- | ----------------------------------------------------------------------------------------- |
| `config.ts`                             | `LOCALES`, `Locale`, cookie name, `normalizeLocale` / `negotiateLocale` / `resolveLocale` |
| `translate.ts`                          | Pure helpers: `lookup`, `interpolate`, `translate` (unit-tested in `translate.spec.ts`)   |
| `server.ts`                             | `loadMessages(locale)`: reads the catalog from disk for the root layout                   |
| `@/components/i18n/locale-provider.tsx` | Client context, catalog fetch, `setLocale` (writes the cookie), `useTranslation()`        |
| `@/components/i18n/locale-switcher.tsx` | The language dropdown                                                                     |

## Usage

```tsx
'use client';
import { useTranslation } from '@/components/i18n/locale-provider';

const { t } = useTranslation();
return <h1>{t('sidebar.Dashboard', 'Dashboard')}</h1>;
```

Always pass the English text as the default. It is what renders before a locale's
catalog is loaded and what shows if a key is missing from that catalog, so a
half-translated language degrades to English rather than to raw keys.

Where a key _does_ exist in the English catalog, write the default to match that
value. The catalog wins wherever it has a key, so a default that disagrees (say
`t('log-out', 'Sign out')` against an English catalog reading `Log Out`) would
render one wording until the catalog loads and another afterwards.

```tsx
t('sidebar.Templates', 'Templates'); // key hit → "Vorlagen" (de)
t('signing.room.title', 'Ready to sign'); // no key → "Ready to sign" everywhere
t('requests.count', '{{count}} documents', { count: 3 });
```

## Locale resolution

`resolveLocale(cookie, acceptLanguage)` in `config.ts`, called once by the root
layout: the `NEXT_LOCALE` cookie wins (an explicit choice), then the browser's
`Accept-Language` preference list, then `en`. The layout sets `<html lang>` and
loads that catalog from disk, so the first paint is already localised. Switching
language in the picker writes the cookie and fetches the catalog in place — no
reload, and the choice survives the next visit.
