/**
 * Per-tenant branding (issue #87), the pure half.
 *
 * `Organization.branding` has existed as free-form JSON with nothing reading
 * it. This module gives it a **shape** and a normalizer, so the mail templates,
 * the signing page and the evidence report all resolve the same values and the
 * same fallbacks. Keeping the type and the platform default here — with no
 * Nest or Prisma import — lets the templates take a `Branding` without pulling
 * the database in behind them.
 *
 * Everything is optional. An organization that has set nothing gets
 * `PLATFORM_BRANDING`, which is exactly what Signara sent before this existed,
 * so the platform identity is the fallback rather than a special case.
 */

export interface Branding {
  /** Shown in the mail header and on the signing page. */
  displayName: string;
  /** Muted line next to the name; empty hides it. */
  tagline: string;
  /** Absolute http(s) logo URL, or null for none. */
  logoUrl: string | null;
  /** Header/button colour; a hex value, never free text into a style block. */
  primaryColor: string;
  /** The footer sentence at the bottom of every mail. */
  footerNote: string;
}

export const PLATFORM_BRANDING: Branding = {
  displayName: 'Signara',
  tagline: 'Secure Every Signature',
  logoUrl: null,
  primaryColor: '#0F62FE',
  footerNote:
    "You received this email because you're participating in a signing workflow on Signara. If this wasn't expected, contact the sender — do not forward signing links.",
};

const HEX_COLOR = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

/** Only an absolute http(s) logo is usable — a `data:`/`javascript:` URL in a
 * mail header is either broken or a foothold, so anything else becomes none. */
function safeLogoUrl(value: unknown): string | null {
  if (typeof value !== 'string' || value.trim() === '') return null;
  try {
    const url = new URL(value.trim());
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.toString() : null;
  } catch {
    return null;
  }
}

function trimmed(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const out = value.trim();
  return out === '' ? null : out;
}

/**
 * Turns stored `Organization.branding` JSON into a complete `Branding`.
 *
 * Field by field: a branding object that is absent or not an object is the
 * platform identity outright. Inside a branding object each field falls back to
 * the platform default, except the display name, which falls back to the
 * organization's own name when it has one — so an organization that set only a
 * logo still signs its mail with its name rather than "Signara".
 */
export function normalizeBranding(raw: unknown, organizationName?: string | null): Branding {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return PLATFORM_BRANDING;
  const source = raw as Record<string, unknown>;

  const explicitName = trimmed(source.displayName);
  const orgName = trimmed(organizationName);
  const logoUrl = safeLogoUrl(source.logoUrl);
  const color = trimmed(source.primaryColor);

  return {
    displayName: explicitName ?? orgName ?? PLATFORM_BRANDING.displayName,
    tagline: trimmed(source.tagline) ?? '',
    logoUrl,
    primaryColor: color && HEX_COLOR.test(color) ? color : PLATFORM_BRANDING.primaryColor,
    footerNote: trimmed(source.footerNote) ?? PLATFORM_BRANDING.footerNote,
  };
}
