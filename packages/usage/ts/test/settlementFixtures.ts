import { DEFAULT_POLICY, FixedClock, InMemoryLedger, InMemoryRepo, SequentialIdGen } from 'boilpayment-core';
import type { Money, Payment } from 'boilpayment-core';
import { FakeProvider, mkSub } from './fixtures.js';

export class BillingProvider extends FakeProvider {
  readonly calls: { amount: Money; key: string; customerRef: string }[] = [];
  readonly charges = new Map<string, Payment>();
  status: Payment['status'] = 'succeeded';
  loseResponse = false;
  capabilities() { return { ...super.capabilities(), nativeSubscriptions: false, meters: false, scheduling: 'self' as const }; }
  async chargeBillingKey(input: { amount: Money; idempotencyKey: string; customerRef: string }): Promise<Payment> {
    this.calls.push({ amount: input.amount, key: input.idempotencyKey, customerRef: input.customerRef });
    const payment = this.charges.get(input.idempotencyKey) ?? { id: 'remote', customerId: 'remote_customer', provider: this.name, providerRef: `remote_${input.idempotencyKey}`, subscriptionId: null, amount: input.amount, status: this.status, kind: 'subscription' as const, period: null, occurredAt: new Date('2026-06-01Z'), failure: null, cashReceipt: null };
    this.charges.set(input.idempotencyKey, payment);
    if (this.loseResponse) { this.loseResponse = false; throw new Error('connection lost after charge'); }
    return payment;
  }
  async getPayment(): Promise<Payment> {
    const payment = this.charges.values().next().value;
    if (!payment) throw new Error('missing payment');
    return { ...payment, status: this.status };
  }
}

export async function given() {
  const ids = new SequentialIdGen('settle_');
  const repo = new InMemoryRepo();
  const ledger = new InMemoryLedger(ids);
  const clock = new FixedClock(new Date('2026-06-01T00:00:00Z'));
  const provider = new BillingProvider();
  const sub = mkSub({ billingKey: 'billing_key' });
  const policy = { ...DEFAULT_POLICY, usage: { ...DEFAULT_POLICY.usage, includedQuantity: 5, overage: 'bill_overage' as const, overageUnitPriceMinor: 250 } };
  await repo.customers.put({ id: sub.customerId, email: null, status: 'active', providerRefs: [{ provider: provider.name, ref: 'provider_customer' }], createdAt: clock.now() });
  await repo.plans.put({ id: sub.planId, name: 'Pro', interval: 'month', creditsPerPeriod: 0, usageIncluded: 5, trialDays: 0, prices: [{ currency: 'KRW', amountMinor: 1000 }] });
  await repo.usageEvents.put({ id: 'event', customerId: sub.customerId, meter: 'call', quantity: 8, occurredAt: sub.currentPeriod.start, receivedAt: clock.now(), periodStart: sub.currentPeriod.start, idempotencyKey: 'event', meta: null });
  return { sub, period: sub.currentPeriod, policy, repo, ledger, clock, provider };
}
