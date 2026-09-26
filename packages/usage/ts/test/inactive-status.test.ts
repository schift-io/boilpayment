// [EC:A27] paused / incomplete subscriptions are not entitled: usage.check refuses them.
import { describe, expect, it } from 'vitest';
import { DEFAULT_POLICY, FixedClock, InMemoryLedger, InMemoryRepo, SequentialIdGen } from 'boilpayment-core';
import { check } from '../src/check.js';
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
