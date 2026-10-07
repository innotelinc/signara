import { Test } from '@nestjs/testing';
import { BrandingService } from './branding.service';
import { PrismaService } from '../../prisma/prisma.service';
import { PLATFORM_BRANDING, normalizeBranding } from './branding';

describe('normalizeBranding', () => {
  it('falls back to the platform identity when there is no branding at all', () => {
    expect(normalizeBranding(null)).toEqual(PLATFORM_BRANDING);
    expect(normalizeBranding(undefined)).toEqual(PLATFORM_BRANDING);
    expect(normalizeBranding('nonsense')).toEqual(PLATFORM_BRANDING);
    expect(normalizeBranding([])).toEqual(PLATFORM_BRANDING);
  });

  it('keeps each field a tenant set and defaults the ones it did not', () => {
    const brand = normalizeBranding({ logoUrl: 'https://cdn.acme.test/logo.png' }, 'Acme Legal');
    expect(brand.logoUrl).toBe('https://cdn.acme.test/logo.png');
    // Display name falls back to the organization's own name, not "Signara".
    expect(brand.displayName).toBe('Acme Legal');
    expect(brand.primaryColor).toBe(PLATFORM_BRANDING.primaryColor);
    expect(brand.footerNote).toBe(PLATFORM_BRANDING.footerNote);
  });

  it('prefers an explicit display name over the organization name', () => {
    expect(normalizeBranding({ displayName: 'Acme Contracts' }, 'Acme Legal').displayName).toBe(
      'Acme Contracts',
    );
  });

  it('refuses a logo that is not an absolute http(s) URL', () => {
    expect(normalizeBranding({ logoUrl: 'javascript:alert(1)' }).logoUrl).toBeNull();
    expect(normalizeBranding({ logoUrl: 'data:image/png;base64,AAAA' }).logoUrl).toBeNull();
    expect(normalizeBranding({ logoUrl: '/relative/logo.png' }).logoUrl).toBeNull();
  });

  it('accepts only a hex colour, so free text cannot land in a style block', () => {
    expect(normalizeBranding({ primaryColor: '#8A2BE2' }).primaryColor).toBe('#8A2BE2');
    expect(normalizeBranding({ primaryColor: '#abc' }).primaryColor).toBe('#abc');
    expect(normalizeBranding({ primaryColor: 'red;}</style>' }).primaryColor).toBe(
      PLATFORM_BRANDING.primaryColor,
    );
  });

  it('lets a tenant blank its tagline', () => {
    expect(normalizeBranding({ tagline: '' }).tagline).toBe('');
  });
});

describe('BrandingService', () => {
  const prismaMock = { organization: { findUnique: jest.fn() } };

  async function build() {
    const moduleRef = await Test.createTestingModule({
      providers: [BrandingService, { provide: PrismaService, useValue: prismaMock }],
    }).compile();
    return moduleRef.get(BrandingService);
  }

  it('returns the platform identity when there is no organization', async () => {
    const service = await build();
    expect(await service.forOrganization(null)).toEqual(PLATFORM_BRANDING);
    expect(prismaMock.organization.findUnique).not.toHaveBeenCalled();
  });

  it('returns the platform identity when the organization is gone', async () => {
    prismaMock.organization.findUnique.mockResolvedValue(null);
    const service = await build();
    expect(await service.forOrganization('org-gone')).toEqual(PLATFORM_BRANDING);
  });

  it('resolves a stored branding row', async () => {
    prismaMock.organization.findUnique.mockResolvedValue({
      name: 'Acme Legal',
      branding: { displayName: 'Acme Legal', primaryColor: '#112233' },
    });
    const service = await build();
    const brand = await service.forOrganization('org-1');
    expect(brand.displayName).toBe('Acme Legal');
    expect(brand.primaryColor).toBe('#112233');
  });
});
