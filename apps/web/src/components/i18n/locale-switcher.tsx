'use client';

import { Globe } from 'lucide-react';
import { LOCALES, type Locale } from '@/lib/i18n/config';
import { cn } from '@/lib/cn';
import { useTranslation } from './locale-provider';

/**
 * Language picker. Each locale is labelled in its own language, so a reader who
 * cannot read the current UI language can still find theirs.
 */
export function LocaleSwitcher({ className }: { className?: string }) {
  const { locale, setLocale, t } = useTranslation();
  const label = t('language', 'Language');

  return (
    <div className={cn('flex items-center gap-3 px-3 py-2', className)}>
      <Globe className="h-4 w-4 shrink-0 text-slate-500" aria-hidden />
      <select
        value={locale}
        onChange={(event) => setLocale(event.target.value as Locale)}
        aria-label={label}
        title={label}
        className="w-full cursor-pointer rounded-md border border-slate-800 bg-ink-950 px-2 py-1 text-sm font-medium text-slate-400 transition-colors hover:border-slate-700 hover:text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-500"
      >
        {LOCALES.map(({ code, label: nativeLabel }) => (
          <option key={code} value={code} className="bg-ink-950 text-white">
            {nativeLabel}
          </option>
        ))}
      </select>
    </div>
  );
}
