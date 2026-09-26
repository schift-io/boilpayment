// [EC:E17] A webhook received fresh and retried by processPending long after the provider's
// timestamp tolerance must still process. The stored body is re-verified (a tampered row fails),
// but freshness is judged at receivedAt.
import { describe, expect, it } from 'vitest';
import { FixedClock, InMemoryRepo, WebhookSignatureError } from 'boilpayment-core';
import type { NormalizedEvent } from 'boilpayment-core';
import { process as processWebhook, processPending, receive } from '../src/index.js';
import { FakeProvider } from './helpers.js';

/** Signs with the clock's time; rejects bodies whose signature or 5-minute freshness fails. */
function tolerantProvider(clock: FixedClock) {
  return new FakeProvider({
    verify: (input: { headers: Record<string, string>; rawBody: string; receivedAt?: Date }): NormalizedEvent => {
      const parsed = JSON.parse(input.rawBody);
      if (input.headers['x-sig'] !== `sig:${parsed.id}:${parsed.amount}`) throw new WebhookSignatureError('bad signature');
      const ref = (input.receivedAt ?? clock.now()).getTime();
      if (Math.abs(ref - Number(input.headers['x-ts'])) > 300_000) throw new WebhookSignatureError('webhook timestamp outside 5-minute tolerance');
      return { id: parsed.id, provider: 'stripe', type: 'unknown', occurredAt: clock.now(), customerRef: null, subscriptionRef: null, paymentRef: null, amount: null, raw: parsed };
    },
  });
}

describe('[EC:E17] retry after the timestamp tolerance', () => {
  it('[EC:E17] processPending 10 minutes after receipt processes the event', async () => {
    const clock = new FixedClock(new Date('2026-09-27T00:00:00Z'));
    const repo = new InMemoryRepo();
    const provider = tolerantProvider(clock);
    const body = JSON.stringify({ id: 'evt_1', amount: 100 });
    const r = await receive({ provider, headers: { 'x-sig': 'sig:evt_1:100', 'x-ts': String(clock.now().getTime()) }, rawBody: body, repo, clock });
    expect(r.status).toBe(200);
    let calls = 0;
    // first attempt fails (e.g. a local row not there yet), leaving the record 'failed'
    await processWebhook({ eventId: r.eventId!, providers: { stripe: provider }, handlers: { unknown: async () => { calls++; throw new Error('not yet'); } }, repo, clock });
    clock.advance(10 * 60_000);
    const res = await processPending({ repo, providers: { stripe: provider }, handlers: { unknown: async () => { calls++; } }, clock });
    const rec = await repo.webhookEvents.get(r.eventId!);
    expect([rec?.status, rec?.error, res.processed, calls]).toEqual(['processed', null, 1, 2]);
  });

  it('[EC:E17] a stored body tampered after receipt is still rejected on retry', async () => {
    const clock = new FixedClock(new Date('2026-09-27T00:00:00Z'));
    const repo = new InMemoryRepo();
    const provider = tolerantProvider(clock);
    const r = await receive({ provider, headers: { 'x-sig': 'sig:evt_2:100', 'x-ts': String(clock.now().getTime()) }, rawBody: JSON.stringify({ id: 'evt_2', amount: 100 }), repo, clock });
    const rec = (await repo.webhookEvents.get(r.eventId!))!;
    await repo.webhookEvents.put({ ...rec, rawBody: JSON.stringify({ id: 'evt_2', amount: 999999 }) });
    clock.advance(10 * 60_000);
    let calls = 0;
    await processWebhook({ eventId: r.eventId!, providers: { stripe: provider }, handlers: { unknown: async () => { calls++; } }, repo, clock });
    const after = await repo.webhookEvents.get(r.eventId!);
    expect([after?.status, after?.error, calls]).toEqual(['failed', 'bad signature', 0]);
  });
});
