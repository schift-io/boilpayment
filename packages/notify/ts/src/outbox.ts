// Durable delivery via repo.outbox. See spec/notify.pseudo.md.
import type { Clock, Notification, Notifier, OutboxItem, Repo } from 'boilpayment-core';

function randomId(): string {
  const g = globalThis as { crypto?: { randomUUID?: () => string } };
  if (g.crypto?.randomUUID) return g.crypto.randomUUID();
  return `notify-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export function withOutbox(notifier: Notifier, repo: Repo): Notifier {
  return {
    async send(n: Notification): Promise<void> {
      const now = new Date();
      const item: OutboxItem = {
        id: randomId(),
        kind: 'notify',
        payload: { notification: n },
        status: 'pending',
        attempts: 0,
        nextAttemptAt: now,
        createdAt: now,
      };
      await repo.outbox.put(item); // never throws — enqueue only; actual send via flushNotifyOutbox
    },
  };
}

function backoffMs(attempts: number): number {
  return Math.min(60, Math.pow(2, attempts)) * 60 * 1000;
}

export interface FlushNotifyOutboxInput {
  repo: Repo;
  notifier: Notifier;
  clock: Clock;
  maxAttempts?: number;
}
export interface FlushNotifyOutboxResult {
  sent: number;
  failed: number;
  retried: number;
}

export async function flushNotifyOutbox(input: FlushNotifyOutboxInput): Promise<FlushNotifyOutboxResult> {
  const { repo, notifier, clock, maxAttempts = 8 } = input;
  const now = clock.now();
  const pending = await repo.outbox.list({ kind: 'notify', status: 'pending' } as Partial<OutboxItem>);

  let sent = 0;
  let failed = 0;
  let retried = 0;

  for (const item of pending) {
    if (item.nextAttemptAt > now) continue;
    const notification = (item.payload as { notification: Notification }).notification;
    try {
      // underlying notifier never throws per the cross-cutting rule; kept in try/catch
      // for defense in depth against non-conforming notifiers.
      await notifier.send(notification);
      item.status = 'sent';
      await repo.outbox.put(item);
      sent += 1;
    } catch {
      item.attempts += 1;
      if (item.attempts >= maxAttempts) {
        item.status = 'failed';
        failed += 1;
      } else {
        item.status = 'pending';
        item.nextAttemptAt = new Date(now.getTime() + backoffMs(item.attempts));
        retried += 1;
      }
      await repo.outbox.put(item);
    }
  }

  return { sent, failed, retried };
}
