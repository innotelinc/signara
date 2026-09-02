import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as nodemailer from 'nodemailer';
import type { Transporter } from 'nodemailer';
import { renderInviteEmail, renderReminderEmail, renderNotificationEmail } from './email-templates';

export interface MailMessage {
  to: string;
  subject: string;
  html: string;
  /** Optional plain-text fallback; when omitted a minimal text body is derived. */
  text?: string;
}

export interface SigningMailContext {
  signerName?: string | null;
  signerEmail: string;
  documentTitle: string;
  requestTitle?: string | null;
  deadline?: Date | null;
  message?: string | null;
  signUrl: string;
  /** 'invite' | 'reminder' */
  kind: 'invite' | 'reminder';
}

/**
 * Central SMTP delivery service.
 *
 * - Creates the nodemailer transporter lazily from SMTP_* configuration.
 * - `send()` returns `false` (and logs at debug level) when SMTP is not
 *   configured, so local development works without a mail server — workers
 *   treat that as "sent, nothing to do" rather than a failure to retry.
 * - Transport errors propagate to the caller so BullMQ can retry with
 *   backoff; the notification worker marks the row FAILED on throw.
 */
@Injectable()
export class EmailService {
  private readonly logger = new Logger(EmailService.name);
  private transporter: Transporter | null = null;

  constructor(private readonly config: ConfigService) {}

  isConfigured(): boolean {
    return Boolean(this.config.get<string>('smtp.host'));
  }

  from(): string {
    return this.config.get<string>('smtp.from') ?? 'Signara <no-reply@signara.innotel.us>';
  }

  /** Sends a signing invitation or reminder with the branded template. */
  async sendSigningMail(ctx: SigningMailContext): Promise<boolean> {
    const { kind } = ctx;
    const { html, text, subject } =
      kind === 'reminder' ? renderReminderEmail(ctx) : renderInviteEmail(ctx);
    return this.send({ to: ctx.signerEmail, subject, html, text });
  }

  /** Sends a generic notification email (in-app notification digests etc.). */
  async sendNotificationMail(input: {
    to: string;
    title: string;
    body?: string | null;
  }): Promise<boolean> {
    const { html, text, subject } = renderNotificationEmail(input.title, input.body ?? '');
    return this.send({ to: input.to, subject, html, text });
  }

  async send(message: MailMessage): Promise<boolean> {
    if (!this.isConfigured()) {
      this.logger.debug(
        `SMTP not configured — skipping email to ${message.to} (subject: "${message.subject}")`,
      );
      return false;
    }

    const transporter = this.getTransporter();
    await transporter.sendMail({
      from: this.from(),
      to: message.to,
      subject: message.subject,
      html: message.html,
      text: message.text ?? this.stripHtml(message.html),
    });
    this.logger.log(`Email sent to ${message.to} (subject: "${message.subject}")`);
    return true;
  }

  // ------------------------------------------------------------- internals --
  private getTransporter(): Transporter {
    if (this.transporter) return this.transporter;

    const port = Number(this.config.get<number>('smtp.port') ?? 587);
    const user = this.config.get<string>('smtp.user') ?? '';
    const pass = this.config.get<string>('smtp.pass') ?? '';
    const secure = this.config.get<string>('smtp.secure') === 'true' || port === 465;

    this.transporter = nodemailer.createTransport({
      host: this.config.get<string>('smtp.host'),
      port,
      secure, // 465 = implicit TLS; else STARTTLS
      ...(user && pass ? { auth: { user, pass } } : {}),
    });
    return this.transporter;
  }

  private stripHtml(html: string): string {
    return html
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/\s+/g, ' ')
      .trim();
  }
}