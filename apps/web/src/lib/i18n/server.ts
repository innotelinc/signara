import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Locale } from './config';
import type { Messages } from './translate';

/**
 * Server-side catalog loader, used by the root layout so the persisted locale
 * renders correctly on the first byte (the client provider only takes over on
 * an in-page locale switch).
 *
 * `public/` is served from two different working directories depending on how
 * the app runs, so both are tried: `apps/web/public` under `next dev`/`next
 * start` (npm workspace cwd) and `<cwd>/apps/web/public` in the standalone
 * container, where cwd is the repo root and `public/` was copied next to
 * `apps/web/server.js` (see Dockerfile).
 */
const CATALOG_ROOTS = ['public/locales', 'apps/web/public/locales'];

const cache = new Map<Locale, Messages>();

/** Load a catalog, or `{}` if no readable copy exists (callers fall back). */
export function loadMessages(locale: Locale): Messages {
  const cached = cache.get(locale);
  if (cached) return cached;

  for (const root of CATALOG_ROOTS) {
    try {
      const raw = readFileSync(join(process.cwd(), root, locale, 'translation.json'), 'utf8');
      const parsed = JSON.parse(raw) as Messages;
      // Only successes are cached, so a locale added at runtime is picked up.
      cache.set(locale, parsed);
      return parsed;
    } catch {
      // Try the next root; a missing catalog is not an error.
    }
  }
  return {};
}
