// Slack incoming-webhook adapter. Never throws — see spec/notify.pseudo.md.
import type { Notification, Notifier } from '@schift/payment-kit-core';
import type { Locale } from './templates.js';
import { renderNotification } from './templates.js';

export interface SlackConfig {
  webhookUrl: string;
  locale?: Locale;
  fetchImpl?: typeof fetch;
}

export function slack(cfg: SlackConfig): Notifier {
  const locale = cfg.locale ?? 'en';
  const fetchFn = cfg.fetchImpl ?? fetch;
  return {
    async send(n: Notification): Promise<void> {
      const { subject, text } = renderNotification(n, locale);
      try {
        const res = await fetchFn(cfg.webhookUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text: `*${subject}*\n${text}` }),
        });
        if (!res.ok) console.error('notify.slack non-2xx', res.status);
      } catch (e) {
        console.error('notify.slack failed', e); // never throw — e.g. unreachable URL
      }
    },
  };
}
