// Fan-out to multiple notifiers. See spec/notify.pseudo.md.
import type { Notification, Notifier } from '@schift/payment-kit-core';

export function composite(notifiers: Notifier[]): Notifier {
  return {
    async send(n: Notification): Promise<void> {
      // Invoke inside an async boundary so synchronous throws also settle per child.
      await Promise.allSettled(notifiers.map(async (nt) => nt.send(n)));
    },
  };
}
