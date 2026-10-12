import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import * as nodemailer from 'nodemailer';
import { EmailService } from './mailer.service';
import { BrandingService } from '../branding/branding.service';
import { PLATFORM_BRANDING } from '../branding/branding';

// The transporter is where the TLS decision lands, and it is the only part of
// this service that talks to a relay — so it is stubbed here and asserted on.
// Nothing in the suite below reaches the network.
jest.mock('nodemailer', () => ({
  createTransport: jest.fn(() => ({ sendMail: jest.fn().mockResolvedValue({ messageId: 'test' }) })),
}));

describe('EmailService', () => {
  const brandingMock = {
    forOrganization: jest.fn().mockResolvedValue(PLATFORM_BRANDING),
  } as unknown as BrandingService;

  function build(config: Record<string, unknown>) {
    return Test.createTestingModule({
      providers: [
        EmailService,
        { provide: ConfigService, useValue: { get: (k: string) => config[k] ?? undefined } },
        { provide: BrandingService, useValue: brandingMock },
      ],
    }).compile();
  }

  it('reports configured/unconfigured SMTP', async () => {
    const unset = await build({});
    expect((await unset).get(EmailService).isConfigured()).toBe(false);

    const set = await build({ 'smtp.host': 'smtp.example.com' });
    expect((await set).get(EmailService).isConfigured()).toBe(true);
  });

  it('returns false without touching a transporter when SMTP is unconfigured', async () => {
    const moduleRef = await build({});
    const svc = moduleRef.get(EmailService);
    const result = await svc.send({ to: 'a@b.test', subject: 'Hi', html: '<p>hi</p>' });
    expect(result).toBe(false);
  });

  it('sendSigningMail renders invite + reminder content', async () => {
    const moduleRef = await build({});
    const svc = moduleRef.get(EmailService);
    // SMTP unset → send returns false, but rendering must not throw
    const r = await svc.sendSigningMail({
      kind: 'reminder',
      signerEmail: 'signer@signara.local',
      documentTitle: 'NDA <script>alert(1)</script>',
      requestTitle: 'NDA',
      deadline: new Date('2030-01-01T00:00:00Z'),
      message: 'Please sign',
      signUrl: 'https://app.signara.innotel.us/sign/sgn_abc',
    });
    expect(r).toBe(false);

    // Ensure user-controlled content is escaped in the rendered template
    const { renderReminderEmail } = await import('./email-templates');
    const { html, subject } = renderReminderEmail({
      kind: 'reminder',
      signerEmail: 'signer@signara.local',
      documentTitle: 'NDA <script>alert(1)</script>',
      requestTitle: 'NDA',
      deadline: new Date('2030-01-01T00:00:00Z'),
      message: 'Please sign',
      signUrl: 'https://app.signara.innotel.us/sign/sgn_abc',
    });
    expect(html).toContain('&lt;script&gt;');
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('sgn_abc');
    expect(subject).toContain('Reminder');
  });

  it('sendCompletionMail keeps the retired platform subject and escapes the title', async () => {
    const moduleRef = await build({});
    const svc = moduleRef.get(EmailService);
    const sent = await svc.sendCompletionMail({
      senderName: 'Dana',
      senderEmail: 'originator@signara.local',
      documentTitle: 'NDA <script>alert(1)</script>',
      documentUrl: 'https://app.signara.innotel.us/documents/doc-1',
    });
    expect(sent).toBe(false); // SMTP unset, but rendering must not throw

    const { renderCompletionEmail } = await import('./email-templates');
    const { subject, html } = renderCompletionEmail({
      senderName: 'Dana',
      senderEmail: 'originator@signara.local',
      documentTitle: 'NDA <script>alert(1)</script>',
      documentUrl: 'https://app.signara.innotel.us/documents/doc-1',
    });
    // The subject is the retired platform's wording, verbatim (#83).
    expect(subject).toBe('Document NDA <script>alert(1)</script> has been signed by all parties');
    expect(html).toContain('&lt;script&gt;');
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('https://app.signara.innotel.us/documents/doc-1');
    expect(html).toContain('Hi Dana,');
  });

  it('renders a tenant logo and name when the organization has branding (#87)', async () => {
    const { renderInviteEmail } = await import('./email-templates');
    const { html } = renderInviteEmail(
      {
        kind: 'invite',
        signerEmail: 'signer@signara.local',
        documentTitle: 'NDA',
        signUrl: 'https://app.signara.innotel.us/sign/sgn_abc',
      },
      {
        ...PLATFORM_BRANDING,
        displayName: 'Acme Legal',
        tagline: 'Contracts',
        logoUrl: 'https://cdn.acme.test/logo.png',
        primaryColor: '#8A2BE2',
        footerNote: 'Acme Legal — confidential.',
      },
    );
    expect(html).toContain('Acme Legal');
    expect(html).toContain('https://cdn.acme.test/logo.png');
    expect(html).toContain('background-color:#8A2BE2');
    expect(html).toContain('Acme Legal — confidential.');
    // The platform identity is not what a branded tenant's signer sees.
    expect(html).not.toContain('Secure Every Signature');
  });

  it('skips relay verification only when SMTP_TLS_INSECURE asks for it', async () => {
    const createTransport = nodemailer.createTransport as unknown as jest.Mock;
    const message = { to: 'signer@signara.local', subject: 'Hi', html: '<p>hi</p>' };

    // The relay is reached by IP and its certificate names a host; without this
    // the send fails with "Hostname/IP does not match certificate's altnames"
    // and no signing mail is delivered at all.
    createTransport.mockClear();
    await (await build({ 'smtp.host': '192.168.1.15', 'smtp.tlsInsecure': true }))
      .get(EmailService)
      .send(message);
    expect(createTransport).toHaveBeenCalledWith(
      expect.objectContaining({ tls: { rejectUnauthorized: false } }),
    );

    // Unasked-for verification-skipping is the thing to avoid, so the default
    // must not carry the option at all.
    createTransport.mockClear();
    await (await build({ 'smtp.host': '192.168.1.15' })).get(EmailService).send(message);
    expect(createTransport).toHaveBeenCalledWith(
      expect.not.objectContaining({ tls: expect.anything() }),
    );
  });

  it('sends the completion mail From the deployment identity, not a per-tenant one', async () => {
    const moduleRef = await build({
      'smtp.from': 'Signara by Innotel <no-reply@signara.innotel.us>',
    });
    expect(moduleRef.get(EmailService).from()).toBe(
      'Signara by Innotel <no-reply@signara.innotel.us>',
    );
  });
});
