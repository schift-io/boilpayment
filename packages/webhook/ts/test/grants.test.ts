// Phase 6 regression tests — packages/webhook/ts/src/grants.ts (EC:E13)
import { describe, expect, it } from 'vitest';
import { FixedClock, InMemoryLedger, InMemoryRepo, SequentialIdGen } from 'boilpayment-core';
import type { Payment } from 'boilpayment-core';
import { getGrantsForCheckout } from '../src/index.js';

describe('webhook.getGrantsForCheckout [EC:E13]', () => {
  it('returns { ready: false } (no customerId/entries) when no payment matches the checkout/paymentRef', async () => {
    const repo = new InMemoryRepo();
    const ledger = new InMemoryLedger(new SequentialIdGen('led_'));

    const result = await getGrantsForCheckout({ checkoutIdOrPaymentRef: 'does_not_exist', repo, ledger });

    expect(result).toEqual({ ready: false });
  });

  it('returns { ready: false } when the matching payment has not reached status=succeeded yet', async () => {
    const clock = new FixedClock(new Date('2026-02-02T00:00:00Z'));
    const repo = new InMemoryRepo();
    const ledger = new InMemoryLedger(new SequentialIdGen('led_'));
    const payment: Payment = {
      id: 'pay_pending', customerId: 'cust_1', provider: 'stripe', providerRef: 'pi_pending', subscriptionId: null,
      amount: { amountMinor: 1000, currency: 'USD' }, status: 'pending', kind: 'topup', period: null,
      occurredAt: clock.now(), failure: null,
    };
    await repo.payments.put(payment);

    const result = await getGrantsForCheckout({ checkoutIdOrPaymentRef: 'pi_pending', repo, ledger });

    expect(result).toEqual({ ready: false });
  });

  it('returns ready=true with customerId and the matching grant entries once a succeeded payment has ledger grants', async () => {
    const clock = new FixedClock(new Date('2026-02-02T00:00:00Z'));
    const repo = new InMemoryRepo();
    const ledger = new InMemoryLedger(new SequentialIdGen('led_'));
    const payment: Payment = {
      id: 'pay_done', customerId: 'cust_1', provider: 'stripe', providerRef: 'pi_done', subscriptionId: null,
      amount: { amountMinor: 2000, currency: 'USD' }, status: 'succeeded', kind: 'topup', period: null,
      occurredAt: clock.now(), failure: null,
    };
    await repo.payments.put(payment);

    const { entry: grantEntry } = await ledger.append({
      customerId: 'cust_1', pool: 'paid', kind: 'grant', amount: 200, unitPriceMinor: null, currency: null,
      expiresAt: null, source: 'topup', reference: { paymentId: payment.id }, idempotencyKey: `topup:${payment.id}`,
      actor: 'system', reason: null,
    });
    // an entry for a different payment on the same customer must be excluded from the result.
    await ledger.append({
      customerId: 'cust_1', pool: 'paid', kind: 'grant', amount: 50, unitPriceMinor: null, currency: null,
      expiresAt: null, source: 'subscription', reference: { paymentId: 'pay_other' }, idempotencyKey: 'other:1',
      actor: 'system', reason: null,
    });

    const result = await getGrantsForCheckout({ checkoutIdOrPaymentRef: 'pi_done', repo, ledger });

    expect(result.ready).toBe(true);
    expect(result.customerId).toBe('cust_1');
    expect(result.entries).toHaveLength(1);
    expect(result.entries?.[0].id).toBe(grantEntry.id);
    expect(result.entries?.[0].amount).toBe(200);
    expect(result.entries?.[0].reference.paymentId).toBe(payment.id);
  });
});
