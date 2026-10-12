import { renderToString } from 'react-dom/server';
import SignDemoPage, { DemoRoom, DocumentPage, routeAfter } from './page';

/**
 * The demo signing room's job is to show what signing *produces*, not to print a
 * thank-you. These tests pin the three things that make it a demo: the request is
 * on screen before signing, the signature lands in the document's signature block
 * afterwards, and completing the last signature flips the whole order to signed.
 */
jest.mock('next/link', () => ({
  __esModule: true,
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={typeof href === 'string' ? href : '#'} {...rest}>
      {children}
    </a>
  ),
}));

/** React separates adjacent text nodes with `<!-- -->` comments in SSR output. */
function text(html: string): string {
  return html.replace(/<!-- -->/g, '');
}

describe('routeAfter', () => {
  const route = [
    {
      initials: 'AL',
      name: 'A. Lopez',
      role: 'Approver',
      state: 'signed' as const,
      signedOn: '2 days ago',
    },
    {
      initials: 'DH',
      name: 'D. Hunter (you)',
      role: 'Signatory',
      state: 'current' as const,
      signedOn: null,
    },
  ];

  it('leaves the order untouched while the request is still waiting', () => {
    const before = routeAfter(route, false);
    expect(before).toEqual(route);
    expect(before.filter((r) => r.state === 'signed')).toHaveLength(1);
  });

  it('marks the visitor signed and completes the order once they sign', () => {
    const after = routeAfter(route, true);
    expect(after[1]).toEqual({
      initials: 'DH',
      name: 'D. Hunter (you)',
      role: 'Signatory',
      state: 'signed',
      signedOn: 'Just now',
    });
    // Earlier signers keep their own timestamps — completion must not rewrite them.
    expect(after[0].signedOn).toBe('2 days ago');
    expect(after.every((r) => r.state === 'signed')).toBe(true);
  });
});

describe('DocumentPage', () => {
  it('shows an empty signature block before signing', () => {
    const html = text(renderToString(<DocumentPage signature={null} />));
    expect(html).toContain('Sign here');
    expect(html).toContain('Unsigned');
    expect(html).not.toContain('>Signed<');
  });

  it('shows the signature, its timestamp and the signed badge after signing', () => {
    const at = new Date('2026-10-12T09:30:00Z');
    const html = text(renderToString(<DocumentPage signature={{ name: 'D. Hunter', at }} />));
    expect(html).toContain('D. Hunter');
    expect(html).toContain('>Signed<');
    expect(html).toContain(at.toLocaleString());
    expect(html).not.toContain('Sign here');
  });
});

describe('SignDemoPage', () => {
  it('starts on the request — document, order and a Sign button — not a thank-you', () => {
    const html = text(renderToString(<SignDemoPage />));
    expect(html).toContain('Master Service Agreement');
    expect(html).toContain('Sign here');
    expect(html).toContain('Sign document');
    expect(html).toContain('dhunter@innotel.us');
    expect(html).toContain('2 of 3 signed');
    expect(html).toContain('Deadline');
    // The completion view must not be what a visitor sees first.
    expect(html).not.toContain('Signing complete');
  });

  it('shows the completed document after signing, not a thank-you', () => {
    // The seeded outcome is the state the page reaches by pressing "Sign
    // document". What it renders then is the point of the demo.
    const html = text(renderToString(<DemoRoom initialOutcome="signed" />));
    expect(html).toContain('Signing complete');
    expect(html).toContain('Signed copy');
    expect(html).toContain('D. Hunter');
    expect(html).toContain('Signed on');
    expect(html).toContain('Completion record');
    expect(html).toContain('req_demo_7f21c4');
    // The signatures card counts 3/3 rather than the waiting view's "N of M".
    expect(html).toContain('3/3');
    // The waiting-state prompt is gone: the signature block is filled in.
    expect(html).not.toContain('Sign here');
    expect(html).not.toContain('Sign document');
  });

  it('renders the sample request without touching the network', () => {
    // The demo is local-only by construction: rendering it must not schedule a
    // fetch (the page has no data layer at all).
    const fetchSpy = jest.spyOn(globalThis, 'fetch' as never);
    renderToString(<SignDemoPage />);
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });
});
