// [EC:D18] An external refund's revoke is tied to grant buckets, so the revoked credits can no longer be
// consumed afterwards (a grant-less revoke left the bucket whole: consume succeeded, balance -100).
import { describe, it, expect } from 'vitest';
import { FixedClock, InMemoryLedger, InMemoryRepo, SequentialIdGen } from 'boilpayment-core';
import type { NormalizedEvent, Payment } from 'boilpayment-core';
import { onExternalRefund } from '../src/index.js';

describe('[EC:D18] external refund revoke is attributed to grants', () => {
  it('[EC:D18] refund then consume: the consume of revoked credits is refused, balance stays 0', async () => {
    const clock = new FixedClock(new Date('2026-01-01T00:00:00Z'));
    const ledger = new InMemoryLedger(new SequentialIdGen('l_'), clock);
    const repo = new InMemoryRepo();
    const payment: Payment = { id: 'pay_1', customerId: 'c', provider: 'stripe', providerRef: 'pi_1', subscriptionId: null,
      amount: { amountMinor: 1000, currency: 'USD' }, status: 'succeeded', kind: 'topup', period: null, occurredAt: clock.now(), failure: null };
    await repo.payments.put(payment);
    await ledger.append({ customerId: 'c', pool: 'paid', kind: 'grant', amount: 100, unitPriceMinor: 10, currency: 'USD', expiresAt: null,
      source: 'topup', reference: { paymentId: 'pay_1' }, idempotencyKey: 'topup:pay_1', actor: 't', reason: null });
    const event = { id: 'evt', provider: 'stripe', type: 'refund.created', occurredAt: clock.now(), customerRef: null, subscriptionRef: null,
      paymentRef: 'pi_1', refundRef: 're_1', amount: { amountMinor: 1000, currency: 'USD' }, raw: {} } as unknown as NormalizedEvent;
    const refund = await onExternalRefund({ event, ledger, repo, cs: { openReconcileMismatchCase: async () => {} }, clock, ids: new SequentialIdGen('i_') });
    const revokes = await ledger.entries('c', { kind: 'revoke' });
    const use = await ledger.consume({ customerId: 'c', poolOrder: ['paid'], amount: 100, idempotencyKey: 'use', meta: {}, now: clock.now(),
      negativeBalance: 'block', negativeFloor: 0 });
    expect(refund.creditsRevoked).toBe(100);
    expect(revokes.every((e) => e.reference.grantId)).toBe(true);
    expect(use.ok).toBe(false);
    expect((await ledger.balance('c', undefined, clock.now())).available).toBe(0);
  });

  it('[EC:D20] a full refund of a price that does not divide evenly (1999 minor → 1000 credits) revokes all 1000, no case', async () => {
    const clock = new FixedClock(new Date('2026-01-01T00:00:00Z'));
    const ledger = new InMemoryLedger(new SequentialIdGen('l_'), clock);
    const repo = new InMemoryRepo();
    await repo.payments.put({ id: 'pay_1', customerId: 'c', provider: 'stripe', providerRef: 'in_1', subscriptionId: null,
      amount: { amountMinor: 1999, currency: 'USD' }, status: 'succeeded', kind: 'subscription', period: null, occurredAt: clock.now(), failure: null } as Payment);
    await ledger.append({ customerId: 'c', pool: 'paid', kind: 'grant', amount: 1000, unitPriceMinor: 1, currency: 'USD', expiresAt: null,
      source: 'subscription', reference: { paymentId: 'pay_1' }, idempotencyKey: 'grant:s', actor: 't', reason: 'remainder_minor:999' });
    const cases: string[] = [];
    const ev = (ref: string, minor: number) => ({ id: `evt_${ref}`, provider: 'stripe', type: 'refund.created', occurredAt: clock.now(), customerRef: null,
      subscriptionRef: null, paymentRef: 'in_1', refundRef: ref, amount: { amountMinor: minor, currency: 'USD' }, raw: {} }) as unknown as NormalizedEvent;
    const run = (event: NormalizedEvent) => onExternalRefund({ event, ledger, repo, clock, ids: new SequentialIdGen(`i_${event.id}_`),
      cs: { openReconcileMismatchCase: async (i) => { cases.push(i.reason); } } });
    const half = await run(ev('re_1', 1000));
    const rest = await run(ev('re_2', 999));
    expect([half.creditsRevoked, rest.creditsRevoked]).toEqual([500, 500]);
    expect(cases).toEqual([]);
    expect((await ledger.balance('c', undefined, clock.now())).available).toBe(0);
  });

  it('[SB-11] external anchor-invoice refund revokes the linked null-priced upgrade delta bucket', async () => {
    const clock = new FixedClock(new Date('2026-01-01T00:00:00Z'));
    const ledger = new InMemoryLedger(new SequentialIdGen('l_'), clock);
    const repo = new InMemoryRepo();
    const invoice: Payment = { id: 'pay_sb11_invoice', customerId: 'c', provider: 'stripe', providerRef: 'in_sb11', subscriptionId: 'sub_1',
      amount: { amountMinor: 2000, currency: 'USD' }, status: 'succeeded', kind: 'subscription', period: null, occurredAt: clock.now(), failure: null };
    await repo.payments.put(invoice);
    await ledger.append({ customerId: 'c', pool: 'paid', kind: 'grant', amount: 1000, unitPriceMinor: 1, currency: 'USD', expiresAt: null,
      source: 'topup', reference: { paymentId: 'pay_unrelated' }, idempotencyKey: 'topup:unrelated', actor: 't', reason: null });
    const delta = (await ledger.append({ customerId: 'c', pool: 'paid', kind: 'grant', amount: 2000, unitPriceMinor: null, currency: null, expiresAt: null,
      source: 'subscription', reference: { paymentId: 'pay_sb11_difference' }, idempotencyKey: 'grant:sb11:delta', actor: 't', reason: null })).entry;
    for (const suffix of ['', ':duplicate']) await ledger.append({
      customerId: 'c', pool: 'paid', kind: 'adjust', amount: 0, unitPriceMinor: null, currency: null, expiresAt: null,
      source: 'subscription', reference: { paymentId: invoice.id, grantId: delta.id }, idempotencyKey: `attribute:sb11${suffix}`,
      actor: 'system', reason: 'SB-11 upgrade_invoice_attribution',
    });
    const event = { id: 'evt_sb11', provider: 'stripe', type: 'refund.created', occurredAt: clock.now(), customerRef: null,
      subscriptionRef: null, paymentRef: invoice.providerRef, refundRef: 're_sb11', amount: { amountMinor: 1000, currency: 'USD' }, raw: {} } as unknown as NormalizedEvent;

    const refund = await onExternalRefund({ event, ledger, repo, cs: { openReconcileMismatchCase: async () => {} }, clock, ids: new SequentialIdGen('i_') });
    const revokes = await ledger.entries('c', { kind: 'revoke' });

    expect(refund.creditsRevoked).toBe(1000);
    expect(revokes.map((entry) => entry.reference.grantId)).toEqual([delta.id]);
  });
});
