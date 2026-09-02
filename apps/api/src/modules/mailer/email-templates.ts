import type { SigningMailContext } from './mailer.service';

/** Escapes user-controlled text so template injection can't break HTML. */
export function escapeHtml(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatDeadline(date: Date | null | undefined): string {
  if (!date) return '';
  return date.toUTCString();
}

function shell(body: string): string {
  return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Signara</title>
  </head>
  <body style="margin:0;padding:0;background-color:#f5f7fa;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#f5f7fa;padding:32px 16px;">
      <tr>
        <td align="center">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background-color:#ffffff;border-radius:12px;overflow:hidden;border:1px solid #e5e7eb;">
            <tr>
              <td style="padding:28px 32px;background-color:#0F62FE;">
                <span style="color:#ffffff;font-size:20px;font-weight:700;letter-spacing:0.5px;">Signara</span>
                <span style="color:#cfe0ff;font-size:12px;margin-left:8px;">Secure Every Signature</span>
              </td>
            </tr>
            <tr>
              <td style="padding:32px;color:#111827;font-size:15px;line-height:1.6;">
                ${body}
              </td>
            </tr>
            <tr>
              <td style="padding:16px 32px 24px;border-top:1px solid #e5e7eb;color:#6b7280;font-size:12px;line-height:1.5;">
                You received this email because you're participating in a signing workflow on Signara.
                If this wasn't expected, contact the sender — do not forward signing links.
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;
}

function button(text: string, href: string): string {
  return `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:24px 0;">
    <tr>
      <td style="border-radius:8px;background-color:#0F62FE;">
        <a href="${escapeHtml(href)}" style="display:inline-block;padding:12px 28px;color:#ffffff;text-decoration:none;font-weight:600;font-size:14px;border-radius:8px;">${escapeHtml(text)}</a>
      </td>
    </tr>
  </table>`;
}

export function renderInviteEmail(ctx: SigningMailContext): { subject: string; html: string; text: string } {
  const subject = `Please sign: ${ctx.documentTitle}`;
  const parts: string[] = [];
  parts.push(
    `<h2 style="margin:0 0 8px;color:#111827;font-size:18px;">You've been invited to sign</h2>`,
    `<p style="margin:0;">${ctx.signerName ? `<strong>${escapeHtml(ctx.signerName)}</strong>, you` : 'You'} have been asked to sign <strong>${escapeHtml(ctx.documentTitle)}</strong> via Signara.</p>`,
  );
  if (ctx.requestTitle && ctx.requestTitle !== ctx.documentTitle) {
    parts.push(`<p style="margin:8px 0 0;color:#374151;">Request: ${escapeHtml(ctx.requestTitle)}</p>`);
  }
  if (ctx.deadline) {
    parts.push(`<p style="margin:8px 0 0;color:#374151;">Sign by: ${escapeHtml(formatDeadline(ctx.deadline))}</p>`);
  }
  if (ctx.message) {
    parts.push(`<p style="margin:8px 0 0;color:#374151;font-style:italic;">"${escapeHtml(ctx.message)}"</p>`);
  }
  parts.push(button('Review & sign document', ctx.signUrl));
  parts.push(
    `<p style="margin:0;font-size:13px;color:#6b7280;">This link is personal and secret — don't forward it. If you're signing in sequence, others can't sign until your turn is complete.</p>`,
  );
  const html = shell(parts.join('\n'));
  return { subject, html, text: `You've been invited to sign ${ctx.documentTitle}. Open ${ctx.signUrl}` };
}

export function renderReminderEmail(ctx: SigningMailContext): { subject: string; html: string; text: string } {
  const subject = `Reminder: ${ctx.documentTitle}`;
  const parts: string[] = [];
  parts.push(
    `<h2 style="margin:0 0 8px;color:#111827;font-size:18px;">Still waiting on your signature</h2>`,
    `<p style="margin:0;">This is a reminder to sign <strong>${escapeHtml(ctx.documentTitle)}</strong>.${ctx.deadline ? ` The requested deadline was ${escapeHtml(formatDeadline(ctx.deadline))}.` : ''}</p>`,
  );
  if (ctx.message) {
    parts.push(`<p style="margin:8px 0 0;color:#374151;font-style:italic;">"${escapeHtml(ctx.message)}"</p>`);
  }
  parts.push(button('Sign the document', ctx.signUrl));
  parts.push(
    `<p style="margin:0;font-size:13px;color:#6b7280;">If you've already signed, you can ignore this message.</p>`,
  );
  const html = shell(parts.join('\n'));
  return { subject, html, text: `Reminder: please sign ${ctx.documentTitle}. Open ${ctx.signUrl}` };
}

export function renderNotificationEmail(title: string, body: string): { subject: string; html: string; text: string } {
  const parts: string[] = [
    `<h2 style="margin:0 0 8px;color:#111827;font-size:18px;">${escapeHtml(title)}</h2>`,
  ];
  if (body) {
    parts.push(`<p style="margin:0;color:#374151;">${escapeHtml(body).replace(/\n/g, '<br/>')}</p>`);
  }
  const html = shell(parts.join('\n'));
  return { subject: title, html, text: body ? `${title}\n\n${body}` : title };
}