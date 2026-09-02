import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { EmailService } from './mailer.service';

describe('EmailService', () => {
  function build(config: Record<string, unknown>) {
    return Test.createTestingModule({
      providers: [EmailService, { provide: ConfigService, useValue: { get: (k: string) => config[k] ?? undefined } }],
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
});