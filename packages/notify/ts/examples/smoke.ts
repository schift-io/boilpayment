// Smoke test — real code path (no mocks of our own modules), real network attempts against
// unreachable/fake endpoints to prove send() never throws. Run (after `tsc` build):
// node <outDir>/examples/smoke.js
import { CollectingNotifier, FixedClock, InMemoryRepo, Notification } from '@schift/payment-kit-core';
import { composite, flushNotifyOutbox, render, resend, slack, smtp, withOutbox } from '../src/index.js';

// withOutbox() stamps nextAttemptAt with the real wall clock (it takes no `clock` param per
// ARCHITECTURE.md §3.5's `withOutbox(notifier, repo)` signature) — set this comfortably in the
// future so flushNotifyOutbox's `clock.now()` reliably clears the item regardless of wall-clock drift.
const clock = new FixedClock(new Date('2027-01-01T00:00:00Z'));

async function main() {
  // ── Templates: EN + KO render for one NotifyType ──
  const en = render('usage.soft_cap', 'en', { meter: 'api_call', overage: 2, included: 5 });
  const ko = render('usage.soft_cap', 'ko', { meter: 'api_call', overage: 2, included: 5 });
  console.log('[template en]', JSON.stringify(en));
  console.log('[template ko]', JSON.stringify(ko));

  const notification: Notification = { type: 'usage.soft_cap', customerId: 'cust_1', payload: { meter: 'api_call', overage: 2, included: 5 } };

  // ── composite([collecting, slack-to-unreachable]) — must never throw ──
  const collecting = new CollectingNotifier();
  const slackUnreachable = slack({ webhookUrl: 'http://127.0.0.1:1/unreachable' }); // port 1: connection refused, fast
  const resendBroken = resend({ apiKey: 'sk_fake', from: 'a@example.com', to: 'b@example.com', fetchImpl: async () => { throw new Error('network down'); } });
  const fanOut = composite([collecting, slackUnreachable, resendBroken]);

  await fanOut.send(notification); // must not throw
  console.log('[composite.send] did not throw. collecting.sent:', JSON.stringify(collecting.sent));

  // ── smtp adapter against an unreachable host — must never throw ──
  const smtpUnreachable = smtp({ host: '127.0.0.1', port: 1, from: 'a@example.com', to: 'b@example.com' });
  await smtpUnreachable.send(notification); // must not throw
  console.log('[smtp.send to unreachable host] did not throw');

  // ── withOutbox + flushNotifyOutbox: durable delivery via repo.outbox ──
  const repo = new InMemoryRepo();
  const durable = withOutbox(collecting, repo);
  await durable.send(notification); // enqueues, does not call collecting directly
  const pendingBefore = await repo.outbox.list({ kind: 'notify', status: 'pending' });
  console.log('[withOutbox] enqueued:', pendingBefore.length, 'collecting.sent still:', collecting.sent.length);

  const flushed = await flushNotifyOutbox({ repo, notifier: collecting, clock });
  console.log('[flushNotifyOutbox]', JSON.stringify(flushed));
  const pendingAfter = await repo.outbox.list({ kind: 'notify', status: 'pending' });
  console.log('[withOutbox] pending after flush:', pendingAfter.length, 'collecting.sent now:', collecting.sent.length);

  console.log('\nsmoke: OK');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
