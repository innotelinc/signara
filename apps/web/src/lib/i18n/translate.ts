/** A loaded translation catalog: nested objects whose leaves are strings. */
export type Messages = Record<string, unknown>;

export type TranslationVars = Record<string, string | number | undefined>;

/**
 * Read a dot-path key out of a catalog. A flat key (`log-out`) is tried first
 * because the harvested OpenSign catalogs mix flat keys and grouped ones.
 * Returns only string leaves — a key that resolves to a group is a miss.
 */
export function lookup(messages: Messages | null | undefined, key: string): string | undefined {
  if (!messages) return undefined;

  const direct = messages[key];
  if (typeof direct === 'string') return direct;

  let node: unknown = messages;
  for (const segment of key.split('.')) {
    if (typeof node !== 'object' || node === null) return undefined;
    node = (node as Record<string, unknown>)[segment];
  }
  return typeof node === 'string' ? node : undefined;
}

/**
 * Replace `{{name}}` placeholders. An unresolved placeholder is left verbatim
 * rather than blanked, so a missing variable shows up in the UI instead of
 * silently dropping a word ("{{count}} documents" → "3 documents").
 */
export function interpolate(template: string, vars?: TranslationVars): string {
  if (!vars) return template;
  return template.replace(/\{\{\s*([\w.-]+)\s*\}\}/g, (match, name: string) => {
    const value = vars[name];
    return value === undefined ? match : String(value);
  });
}

/**
 * Translate `key`, in order of preference: the catalog value, the caller's
 * English `defaultValue`, then the key itself as a visible last resort.
 *
 * The inline default is what makes partial catalogs safe — the UI reads
 * correctly in English before a locale is ever loaded, and a missing
 * translation for one locale falls back to English text instead of a key.
 */
export function translate(
  messages: Messages | null | undefined,
  key: string,
  defaultValue?: string,
  vars?: TranslationVars,
): string {
  const template = lookup(messages, key) ?? defaultValue ?? key;
  return interpolate(template, vars);
}
