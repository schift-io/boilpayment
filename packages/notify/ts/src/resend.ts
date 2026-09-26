// Resend email adapter. Never throws — see spec/notify.pseudo.md.
import type { Notification, Notifier } from 'boilpayment-core';
import type { Locale } from './templates.js';
import { renderNotification } from './templates.js';

export interface ResendConfig {
  apiKey: string;
  from: string;
  to: string;
  locale?: Locale;
  /** override for tests — defaults to global fetch */
  fetchImpl?: typeof fetch;
}

export function resend(cfg: ResendConfig): Notifier {
  const locale = cfg.locale ?? 'en';
  const fetchFn = cfg.fetchImpl ?? fetch;
  return {
    async send(n: Notification): Promise<void> {
      const { subject, text } = renderNotification(n, locale);
      const recipient = (n.payload.email as string | undefined) ?? cfg.to;
      try {
        const res = await fetchFn('https://api.resend.com/emails', {
          method: 'POST',
          headers: { Authorization: `Bearer ${cfg.apiKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ from: cfg.from, to: recipient, subject, text }),
        });
        if (!res.ok) console.error('notify.resend non-2xx', res.status);
      } catch (e) {
        console.error('notify.resend failed', e); // never throw
      }
    },
  };
}
