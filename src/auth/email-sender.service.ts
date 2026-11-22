import { Injectable, Logger } from '@nestjs/common';
import { redactSensitiveText } from '../common/data-crypto.utils';

export interface SendBrandedEmailParams {
  toEmail: string;
  toName: string;
  subject: string;
  html: string;
  text: string;
}

@Injectable()
export class EmailSenderService {
  private readonly logger = new Logger(EmailSenderService.name);

  hasCustomProvider(): boolean {
    const hasBrevo = Boolean(
      process.env.BREVO_API_KEY?.trim() &&
      (process.env.MAIL_FROM_EMAIL?.trim() || process.env.MAIL_FROM?.trim()),
    );
    const hasResend = Boolean(process.env.RESEND_API_KEY?.trim());
    return hasBrevo || hasResend;
  }

  private extractEmailAddress(raw: string): string {
    const match = raw.match(/<([^>]+)>/);
    return (match ? match[1] : raw).trim();
  }

  private extractSenderName(raw: string): string {
    const match = raw.match(/^([^<]+)</);
    const cleaned = match ? match[1].replace(/^["']|["']$/g, '').trim() : '';
    return cleaned || process.env.MAIL_FROM_NAME?.trim() || 'Painel Monet';
  }

  async sendHtmlEmail(
    params: SendBrandedEmailParams,
  ): Promise<{ sent: boolean; provider: 'brevo' | 'resend' | 'none' }> {
    const brevoApiKey = process.env.BREVO_API_KEY?.trim();
    const rawFrom =
      process.env.MAIL_FROM_EMAIL?.trim() ||
      process.env.MAIL_FROM?.trim() ||
      '';

    if (brevoApiKey && rawFrom) {
      const senderEmail = this.extractEmailAddress(rawFrom);
      const senderName = this.extractSenderName(rawFrom);
      const response = await fetch('https://api.brevo.com/v3/smtp/email', {
        method: 'POST',
        headers: {
          'api-key': brevoApiKey,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify({
          sender: { name: senderName, email: senderEmail },
          to: [{ email: params.toEmail, name: params.toName || 'Cliente' }],
          subject: params.subject,
          htmlContent: params.html,
          textContent: params.text,
        }),
      });

      if (response.ok) {
        return { sent: true, provider: 'brevo' };
      }

      const errText = await response.text();
      this.logger.error(
        `Falha ao enviar e-mail via Brevo (${response.status}): ${redactSensitiveText(errText).slice(0, 200)}`,
      );
      return { sent: false, provider: 'brevo' };
    }

    const resendApiKey = process.env.RESEND_API_KEY?.trim();
    if (resendApiKey) {
      const fromHeader =
        process.env.MAIL_FROM?.trim() ||
        (process.env.MAIL_FROM_EMAIL?.trim()
          ? `Painel Monet <${this.extractEmailAddress(process.env.MAIL_FROM_EMAIL)}>`
          : 'Painel Monet <onboarding@resend.dev>');

      const response = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${resendApiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          from: fromHeader,
          to: [params.toEmail],
          subject: params.subject,
          html: params.html,
          text: params.text,
        }),
      });

      if (response.ok) {
        return { sent: true, provider: 'resend' };
      }

      const errText = await response.text();
      this.logger.error(
        `Falha ao enviar e-mail via Resend (${response.status}): ${redactSensitiveText(errText).slice(0, 200)}`,
      );
      return { sent: false, provider: 'resend' };
    }

    return { sent: false, provider: 'none' };
  }
}