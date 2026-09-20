'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { LOCALE_COOKIE, type Locale } from '@/lib/i18n/config';
import { translate, type Messages, type TranslationVars } from '@/lib/i18n/translate';

interface LocaleContextValue {
  locale: Locale;
  setLocale: (locale: Locale) => void;
  /**
   * `t(key, defaultValue?, vars?)` — the catalog value for `key`, else the
   * English default, else the key. See `lib/i18n/translate.ts`.
   */
  t: (key: string, defaultValue?: string, vars?: TranslationVars) => string;
}

const LocaleContext = createContext<LocaleContextValue | null>(null);

/** Client-side catalog cache, so switching back to a locale is instant. */
const catalogCache = new Map<Locale, Messages>();

export function LocaleProvider({
  locale: initialLocale,
  messages: initialMessages,
  children,
}: {
  locale: Locale;
  messages: Messages;
  children: React.ReactNode;
}) {
  const [locale, setLocaleState] = useState<Locale>(initialLocale);
  const [messages, setMessages] = useState<Messages>(initialMessages);
  const seeded = useRef(false);

  // The server already loaded the first locale; seed the cache from it so the
  // mount effect below does not re-fetch the catalog we were handed.
  useEffect(() => {
    if (seeded.current) return;
    seeded.current = true;
    if (Object.keys(initialMessages).length > 0) catalogCache.set(initialLocale, initialMessages);
  }, [initialLocale, initialMessages]);

  useEffect(() => {
    document.documentElement.lang = locale;
  }, [locale]);

  useEffect(() => {
    const cached = catalogCache.get(locale);
    if (cached) {
      setMessages(cached);
      return;
    }

    let cancelled = false;
    fetch(`/locales/${locale}/translation.json`)
      .then((response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return response.json() as Promise<Messages>;
      })
      .then((catalog) => {
        catalogCache.set(locale, catalog);
        if (!cancelled) setMessages(catalog);
      })
      .catch(() => {
        // A locale that cannot be fetched degrades to the English defaults the
        // call sites already pass, rather than breaking the page.
        if (!cancelled) setMessages({});
      });

    return () => {
      cancelled = true;
    };
  }, [locale]);

  const setLocale = useCallback((next: Locale) => {
    document.cookie = `${LOCALE_COOKIE}=${next}; path=/; max-age=31536000; samesite=lax`;
    setLocaleState(next);
  }, []);

  const value = useMemo<LocaleContextValue>(
    () => ({
      locale,
      setLocale,
      t: (key, defaultValue, vars) =>
        translate(messages, key, defaultValue, { appName: 'Signara', ...vars }),
    }),
    [locale, setLocale, messages],
  );

  return <LocaleContext.Provider value={value}>{children}</LocaleContext.Provider>;
}

export function useTranslation(): LocaleContextValue {
  const context = useContext(LocaleContext);
  if (!context) {
    throw new Error('useTranslation must be used inside a <LocaleProvider>');
  }
  return context;
}
