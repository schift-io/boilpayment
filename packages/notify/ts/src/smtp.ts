// SMTP email adapter via nodemailer. Never throws — see spec/notify.pseudo.md.
import type { Notification, Notifier } from '@schift/payment-kit-core';
import nodemailer from 'nodemailer';
import type { Locale } from './templates.js';
import { renderNotification } from './templates.js';

export interface SmtpConfig {
  host: string;
  port: number;
  secure?: boolean;
  auth?: { user: string; pass: string };
  from: string;
  to: string;
  locale?: Locale;
}

export function smtp(cfg: SmtpConfig): Notifier {
  const locale = cfg.locale ?? 'en';
  const transporter = nodemailer.createTransport({
    host: cfg.host,
    port: cfg.port,
    secure: cfg.secure ?? false,
    auth: cfg.auth,
  });
  return {
    async send(n: Notification): Promise<void> {
      const { subject, text } = renderNotification(n, locale);
      const recipient = (n.payload.email as string | undefined) ?? cfg.to;
      try {
        await transporter.sendMail({ from: cfg.from, to: recipient, subject, text });
      } catch (e) {
        console.error('notify.smtp failed', e); // never throw
      }
    },
  };
}
