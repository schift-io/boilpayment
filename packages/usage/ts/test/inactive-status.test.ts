// [EC:A27] paused / incomplete subscriptions are not entitled: usage.check refuses them.
import { describe, expect, it } from 'vitest';
import { DEFAULT_POLICY, FixedClock, InMemoryLedger, InMemoryRepo, SequentialIdGen } from 'boilpayment-core';
import { check } from '../src/check.js';
import { reserve } from '../src/reservation.js';
import { mkSub } from './fixtures.js';

describe('[EC:A27] usage.check on an inactive subscription', () => {
  for (const status of ['paused', 'incomplete'] as const) {
    it(`[EC:A27] ${status} -> allow false, reason subscription_inactive`, async () => {
      const ids = new SequentialIdGen('id_');
      const clock = new FixedClock(new Date('2026-05-15T00:00:00Z'));
      const r = await check({ customerId: 'cust_1', meter: 'api_call', quantity: 1, sub: mkSub({ status }), policy: DEFAULT_POLICY,
        repo: new InMemoryRepo(), ledger: new InMemoryLedger(ids), clock });
      expect([r.allow, r.reason]).toEqual([false, 'subscription_inactive']);
    });
  }
});

describe('[EC:C11] ended subscriptions carry no entitlement', () => {
  for (const status of ['canceled', 'expired'] as const) {
    it(`[EC:C11] usage.check on ${status} -> subscription_inactive`, async () => {
      const ids = new SequentialIdGen('id_');
      const clock = new FixedClock(new Date('2026-05-15T00:00:00Z'));
      const r = await check({ customerId: 'cust_1', meter: 'api_call', quantity: 1, sub: mkSub({ status }), policy: DEFAULT_POLICY,
        repo: new InMemoryRepo(), ledger: new InMemoryLedger(ids), clock });
      expect([r.allow, r.reason]).toEqual([false, 'subscription_inactive']);
    });
  }
  for (const status of ['paused', 'incomplete', 'canceled', 'expired'] as const) {
    it(`[EC:C11] usage.reserve with a ${status} subscription is refused before any hold`, async () => {
      const clock = new FixedClock(new Date('2026-05-15T00:00:00Z'));
      const ledger = new InMemoryLedger(new SequentialIdGen('l_'), clock);
      await ledger.append({ customerId: 'cust_1', pool: 'trial', kind: 'grant', amount: 100, unitPriceMinor: null, currency: null, expiresAt: null,
        source: 'trial', reference: {}, idempotencyKey: 'g', actor: 't', reason: null });
      const r = await reserve({ customerId: 'cust_1', jobId: 'job', amount: 10, policy: DEFAULT_POLICY, ledger, clock, sub: mkSub({ status }) });
      expect(r).toEqual({ ok: false, reason: 'subscription_inactive' });
      expect(await ledger.entries('cust_1', { kind: 'hold' })).toEqual([]);
    });
  }
});
