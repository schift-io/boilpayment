// Phase 6 regression tests — withOutbox() enqueue + flushNotifyOutbox() delivery/retry.
// Ground truth measured this session via packages/notify/ts/examples/smoke.ts:
//   [withOutbox] enqueued: 1 collecting.sent still: 1   (one withOutbox.send() enqueues a
//     pending row; it does NOT call the wrapped notifier directly — collecting.sent is
//     unaffected by the withOutbox call itself, only by a separate direct notifier.send())
//   [flushNotifyOutbox] {"sent":1,"failed":0,"retried":0}
//   [withOutbox] pending after flush: 0 collecting.sent now: 2   (flush delivers the queued
//     item to the real notifier, moving collecting.sent from 1 -> 2, and the outbox has 0
//     pending afterward)
import { describe, expect, it } from 'vitest';
import { CollectingNotifier, FixedClock, InMemoryRepo } from '@schift/payment-kit-core';
import type { Notification, Notifier } from '@schift/payment-kit-core';
import { flushNotifyOutbox, withOutbox } from '../src/index.js';

const notification: Notification = { type: 'usage.soft_cap', customerId: 'cust_1', payload: { meter: 'api_call', overage: 2, included: 5 } };

// Defense-in-depth path in flushNotifyOutbox is only reachable via a non-conforming notifier
// (real adapters here never throw, per spec/notify.pseudo.md). This double exists purely to
// exercise that retry/attempts logic, which is otherwise dead code against conforming notifiers.
class FailingNotifier implements Notifier {
  calls = 0;
  async send(_n: Notification): Promise<void> {
    this.calls += 1;
    throw new Error('notifier failure (test double)');
  }
}

describe('notify: outbox enqueue+flush', () => {
  it('notify: outbox enqueue+flush — withOutbox.send() enqueues a pending row and does not call the wrapped notifier directly', async () => {
    const repo = new InMemoryRepo();
    const collecting = new CollectingNotifier();
    const durable = withOutbox(collecting, repo);

    await durable.send(notification);

    expect(collecting.sent).toEqual([]); // not delivered directly
    const pending = await repo.outbox.list({ kind: 'notify', status: 'pending' });
    expect(pending).toHaveLength(1);
    const row = pending[0];
    expect(row.kind).toBe('notify');
    expect(row.status).toBe('pending');
    expect(row.attempts).toBe(0);
    expect(row.payload).toEqual({ notification });
    expect(typeof row.id).toBe('string');
    expect(row.id.length).toBeGreaterThan(0);
    expect(row.createdAt).toBeInstanceOf(Date);
    expect(row.nextAttemptAt).toBeInstanceOf(Date);
  });

  it('notify: outbox enqueue+flush — flushNotifyOutbox delivers the queued item, moves status pending->sent, clears pending count', async () => {
    const repo = new InMemoryRepo();
    const collecting = new CollectingNotifier();
    const durable = withOutbox(collecting, repo);
    const clock = new FixedClock(new Date('2027-01-01T00:00:00Z'));

    await durable.send(notification);
    const result = await flushNotifyOutbox({ repo, notifier: collecting, clock });

    expect(result).toEqual({ sent: 1, failed: 0, retried: 0 });
    expect(collecting.sent).toEqual([notification]);
    const pendingAfter = await repo.outbox.list({ kind: 'notify', status: 'pending' });
    expect(pendingAfter).toHaveLength(0);
    const sentRows = await repo.outbox.list({ kind: 'notify', status: 'sent' });
    expect(sentRows).toHaveLength(1);
    expect(sentRows[0].attempts).toBe(0); // success path never increments attempts
  });

  it('notify: outbox enqueue+flush — direct notifier.send() and a separate withOutbox.send() are independent until flush', async () => {
    const repo = new InMemoryRepo();
    const collecting = new CollectingNotifier();
    const durable = withOutbox(collecting, repo);
    const clock = new FixedClock(new Date('2027-01-01T00:00:00Z'));

    await durable.send(notification); // enqueues only
    await collecting.send(notification); // direct call, bypasses outbox
    expect(collecting.sent).toHaveLength(1); // only the direct call landed so far

    const pendingBefore = await repo.outbox.list({ kind: 'notify', status: 'pending' });
    expect(pendingBefore).toHaveLength(1);

    await flushNotifyOutbox({ repo, notifier: collecting, clock });
    expect(collecting.sent).toHaveLength(2); // flush delivered the queued item too
  });

  it('notify: outbox enqueue+flush — a notifier failure during flush leaves the row retryable (pending, attempts incremented, nextAttemptAt pushed forward)', async () => {
    const repo = new InMemoryRepo();
    const collecting = new CollectingNotifier();
    const durable = withOutbox(collecting, repo);
    const clock = new FixedClock(new Date('2027-01-01T00:00:00Z'));
    const failing = new FailingNotifier();

    await durable.send(notification);
    const result = await flushNotifyOutbox({ repo, notifier: failing, clock, maxAttempts: 8 });

    expect(result).toEqual({ sent: 0, failed: 0, retried: 1 });
    expect(failing.calls).toBe(1);
    const pending = await repo.outbox.list({ kind: 'notify', status: 'pending' });
    expect(pending).toHaveLength(1);
    expect(pending[0].attempts).toBe(1);
    expect(pending[0].nextAttemptAt.getTime()).toBeGreaterThan(clock.now().getTime());

    // A flush before nextAttemptAt is reached must not retry the row again (respects the backoff).
    const resultTooSoon = await flushNotifyOutbox({ repo, notifier: failing, clock, maxAttempts: 8 });
    expect(resultTooSoon).toEqual({ sent: 0, failed: 0, retried: 0 });
    expect(failing.calls).toBe(1);
  });

  it('notify: outbox enqueue+flush — a row exhausting maxAttempts is marked failed (source has no further retry beyond maxAttempts)', async () => {
    const repo = new InMemoryRepo();
    const collecting = new CollectingNotifier();
    const durable = withOutbox(collecting, repo);
    const failing = new FailingNotifier();
    const clock = new FixedClock(new Date('2027-01-01T00:00:00Z'));

    await durable.send(notification);

    // maxAttempts: 1 -> the very first failed attempt reaches the limit and is marked failed.
    const result = await flushNotifyOutbox({ repo, notifier: failing, clock, maxAttempts: 1 });

    expect(result).toEqual({ sent: 0, failed: 1, retried: 0 });
    const failedRows = await repo.outbox.list({ kind: 'notify', status: 'failed' });
    expect(failedRows).toHaveLength(1);
    expect(failedRows[0].attempts).toBe(1);
    const pending = await repo.outbox.list({ kind: 'notify', status: 'pending' });
    expect(pending).toHaveLength(0);

    // Once failed, the row is not picked up by list({status:'pending'}) again -> no further retry.
    const secondFlush = await flushNotifyOutbox({ repo, notifier: failing, clock, maxAttempts: 1 });
    expect(secondFlush).toEqual({ sent: 0, failed: 0, retried: 0 });
    expect(failing.calls).toBe(1);
  });
});
