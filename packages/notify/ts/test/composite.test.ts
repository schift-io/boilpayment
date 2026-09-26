// Notification delivery must isolate every child failure.
import { describe, expect, it } from 'vitest';
import { CollectingNotifier } from 'boilpayment-core';
import type { Notification, Notifier } from 'boilpayment-core';
import { composite } from '../src/index.js';

const notification: Notification = { type: 'usage.soft_cap', customerId: 'cust_1', payload: { meter: 'api_call', overage: 2, included: 5 } };

function rejectingNotifier(message: string): Notifier {
  // async fn that throws -> a *rejected Promise*, the shape a real adapter would never
  // produce (adapters never throw) but which composite's allSettled is meant to defend against.
  return {
    async send(_n: Notification): Promise<void> {
      throw new Error(message);
    },
  };
}

function syncThrowingNotifier(message: string): Notifier {
  // NOT an async function: throws synchronously the instant .send() is called, before any
  // Promise is returned at all.
  return {
    send(_n: Notification): Promise<void> {
      throw new Error(message);
    },
  };
}

describe('notify: composite swallows child throw', () => {
  it('notify: composite swallows child throw — rejected-promise children never block delivery to a CollectingNotifier', async () => {
    const collecting = new CollectingNotifier();
    const fanOut = composite([collecting, rejectingNotifier('boom-a'), rejectingNotifier('boom-b')]);

    await expect(fanOut.send(notification)).resolves.toBeUndefined();
    expect(collecting.sent).toEqual([notification]);
  });

  it('notify: composite swallows child throw — non-throwing children still receive the notification even with a throwing sibling', async () => {
    const first = new CollectingNotifier();
    const second = new CollectingNotifier();
    const fanOut = composite([first, rejectingNotifier('boom'), second]);

    await fanOut.send(notification);
    expect(first.sent).toEqual([notification]);
    expect(second.sent).toEqual([notification]);
  });

  it('notify: isolates a synchronous failure after a healthy child', async () => {
    const collecting = new CollectingNotifier();
    const fanOut = composite([collecting, syncThrowingNotifier('sync-throw')]);

    await expect(fanOut.send(notification)).resolves.toBeUndefined();
    expect(collecting.sent).toEqual([notification]);
  });

  it('notify: delivers to healthy children after a synchronous failure', async () => {
    const collecting = new CollectingNotifier();
    const fanOut = composite([syncThrowingNotifier('sync-throw'), collecting]);

    await expect(fanOut.send(notification)).resolves.toBeUndefined();
    expect(collecting.sent).toEqual([notification]);
  });
});
