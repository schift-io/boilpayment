// spec: packages/credits/spec/credits.pseudo.md [EC:B3] [EC:L5]
//
// EC:L5 — asserted against a spy LedgerStore rather than InMemoryLedger: InMemoryLedger.consume()
// (packages/core, owned by another agent, not touched here) rebuilds each written entry's
// `reference` from a fixed field whitelist (subscriptionId/periodStart/paymentId/caseId/refundId/
// grantId) and does NOT copy `meta.correlationId` through — so a real end-to-end assertion against
// InMemoryLedger.entries() would fail even though credits.consume() itself threads correlationId
// correctly into the `ConsumeInput.meta` it hands to `ledger.consume()`. See final report
// "계약 변경 제안". `append()`-based operations (grant/topup/clawback/regrant/dispute/refund) are
// unaffected — InMemoryLedger.append() stores whatever `reference` it is given verbatim.
import { describe, expect, it } from 'vitest';
import { FixedClock, resolvePolicy } from 'boilpayment-core';
import type { ConsumeInput, ConsumeResult, LedgerStore } from 'boilpayment-core';
import { consume } from '../src/index.js';

const clock = new FixedClock(new Date('2024-01-01T00:00:00.000Z'));

function spyLedger(): LedgerStore & { calls: ConsumeInput[] } {
  const calls: ConsumeInput[] = [];
  const result: ConsumeResult = { ok: true, entries: [], shortfall: 0, duplicated: false };
  return {
    calls,
    async append() { throw new Error('unused: append'); },
    async balance() { throw new Error('unused: balance'); },
    async entries() { throw new Error('unused: entries'); },
    async consume(input: ConsumeInput) { calls.push(input); return result; },
    async transaction<T>(_customerId: string, fn: () => Promise<T>) { return fn(); },
  };
}

describe('[EC:L5] correlationId propagation', () => {
  it('[EC:L5] consume threads correlationId into meta.correlationId on the ConsumeInput passed to the ledger', async () => {
    const ledger = spyLedger();
    await consume({
      customerId: 'cust_1', amount: 40, policy: resolvePolicy(), ledger, clock,
      idempotencyKey: 'consume:1', correlationId: 'corr_consume_1',
    });
    expect(ledger.calls).toHaveLength(1);
    expect(ledger.calls[0].meta.correlationId).toBe('corr_consume_1');
  });

  it('[EC:L5] does not overwrite a correlationId already set on `reference`', async () => {
    const ledger = spyLedger();
    await consume({
      customerId: 'cust_1', amount: 40, policy: resolvePolicy(), ledger, clock,
      idempotencyKey: 'consume:2', reference: { correlationId: 'from_reference' }, correlationId: 'from_param',
    });
    expect(ledger.calls[0].meta.correlationId).toBe('from_reference');
  });

  it('[EC:L5] no correlationId -> meta.correlationId stays undefined', async () => {
    const ledger = spyLedger();
    await consume({
      customerId: 'cust_1', amount: 40, policy: resolvePolicy(), ledger, clock,
      idempotencyKey: 'consume:3',
    });
    expect(ledger.calls[0].meta.correlationId).toBeUndefined();
  });
});
