// Smoke test — real code path (no mocks of our own modules), only a fake PaymentProvider
// (no real PG in examples). Run: node_modules/.bin/tsx packages/refund/ts/examples/smoke.ts
import {
  DEFAULT_POLICY, FixedClock, InMemoryLedger, InMemoryRepo, Payment, PaymentKitError, PaymentProvider, Policy,
  Refund, SequentialIdGen,
} from '@schift/payment-kit-core';
import { evaluate, execute } from '../src/index.js';

const ids = new SequentialIdGen('id_');
const clock = new FixedClock(new Date('2026-01-01T00:00:00Z'));
const ledger = new InMemoryLedger(ids);
const repo = new InMemoryRepo();

// Fake provider: refund() always succeeds.
class FakeProvider implements PaymentProvider {
  readonly name = 'stripe' as const;
  capabilities() { return { nativeSubscriptions: true, partialRefund: true, meters: false, scheduling: 'provider' as const, webhookSignature: true }; }
  async createCustomer() { return { ref: 'cus_fake' }; }
  async createCheckout(): Promise<never> { throw new Error('unused'); }
  async getPayment(): Promise<never> { throw new Error('unused'); }
  async listPayments() { return []; }
  async getSubscription(): Promise<never> { throw new Error('unused'); }
  async changeSubscription(): Promise<never> { throw new Error('unused'); }
  async cancelSubscription(): Promise<never> { throw new Error('unused'); }
  async chargeBillingKey(): Promise<never> { throw new Error('unused'); }
  async refund(input: { paymentRef: string; amount: { amountMinor: number; currency: string } }): Promise<Refund> {
    // Mirrors the real provider adapters (Stripe/Polar/Toss/Portone): customerId/ruleId are unknown
    // to the provider, id is the provider's own cancellation id — execute() must overwrite these.
    return {
      id: `cancel_${input.paymentRef}`, paymentId: 'unused', customerId: '', amount: input.amount, status: 'succeeded',
      providerRef: `pref_${input.paymentRef}`, creditsRevoked: 0, ruleId: '', reason: null, failure: null,
      createdAt: new Date(),
    };
  }
  async reportUsage() {}
  async verifyWebhook(): Promise<never> { throw new Error('unused'); }
}

// EC:D13 — Toss virtual-account refund missing extra.refundReceiveAccount.
class ReceiveAccountRequiredProvider extends FakeProvider {
  async refund(): Promise<never> {
    throw new PaymentKitError('refundReceiveAccount required for Toss virtual account refunds', 'refund_receive_account_required');
  }
}

const provider = new FakeProvider();
const policy: Policy = DEFAULT_POLICY;

async function main() {
  const customerId = 'cust_1';

  // ── Scenario 1: payment $10 -> 100 credits (unitPrice 10 minor) -> consume 40 -> evaluate at day 3 ──
  const payment1: Payment = {
    id: 'pay_1', customerId, provider: 'stripe', providerRef: 'pi_1', subscriptionId: null,
    amount: { amountMinor: 1000, currency: 'USD' }, status: 'succeeded', kind: 'topup', period: null,
    occurredAt: clock.now(), failure: null,
  };
  await repo.payments.put(payment1);

  const { entry: grant1 } = await ledger.append({
    customerId, pool: 'paid', kind: 'grant', amount: 100, unitPriceMinor: 10, currency: 'USD', expiresAt: null,
    source: 'topup', reference: { paymentId: payment1.id }, idempotencyKey: `topup:${payment1.id}`, actor: 'system', reason: null,
  });
  console.log('grant1:', grant1.amount, 'credits @ unitPrice', grant1.unitPriceMinor);

  const consumeResult = await ledger.consume({
    customerId, poolOrder: ['paid'], amount: 40, idempotencyKey: 'consume:1',
    meta: { reason: 'usage' }, now: clock.now(), negativeBalance: policy.credits.negativeBalance, negativeFloor: policy.credits.negativeFloor,
  });
  console.log('consume 40 ok:', consumeResult.ok, 'balance after:', (await ledger.balance(customerId, 'paid', clock.now())).available);

  clock.advance(3 * 24 * 60 * 60 * 1000); // day 3
  const decision1 = await evaluate({ payment: payment1, policy, ledger, repo, clock });
  console.log('\n[evaluate #1 @ day3]', JSON.stringify(decision1, null, 2));

  const refund1 = await execute({ decision: decision1, provider, ledger, repo, clock, ids });
  console.log('\n[execute #1]', JSON.stringify(refund1, null, 2));
  console.log('balance after execute #1:', (await ledger.balance(customerId, 'paid', clock.now())).available);

  // ── Scenario 2: fresh payment, unused_credits method, evaluate at day 20 ──
  const payment2: Payment = {
    id: 'pay_2', customerId, provider: 'stripe', providerRef: 'pi_2', subscriptionId: null,
    amount: { amountMinor: 1000, currency: 'USD' }, status: 'succeeded', kind: 'topup', period: null,
    occurredAt: clock.now(), failure: null,
  };
  await repo.payments.put(payment2);
  await ledger.append({
    customerId, pool: 'paid', kind: 'grant', amount: 100, unitPriceMinor: 10, currency: 'USD', expiresAt: null,
    source: 'topup', reference: { paymentId: payment2.id }, idempotencyKey: `topup:${payment2.id}`, actor: 'system', reason: null,
  });
  await ledger.consume({
    customerId, poolOrder: ['paid'], amount: 30, idempotencyKey: 'consume:2',
    meta: { reason: 'usage' }, now: clock.now(), negativeBalance: policy.credits.negativeBalance, negativeFloor: policy.credits.negativeFloor,
  });

  clock.advance(20 * 24 * 60 * 60 * 1000); // now 20 days after payment2.occurredAt
  const decision2 = await evaluate({ payment: payment2, policy, ledger, repo, clock });
  console.log('\n[evaluate #2 @ day20, method=unused_credits]', JSON.stringify(decision2, null, 2));

  // ── Scenario 3: EC:D13 — Toss virtual-account refund missing refundReceiveAccount ──
  const payment3: Payment = {
    id: 'pay_3', customerId, provider: 'toss', providerRef: 'pi_3', subscriptionId: null,
    amount: { amountMinor: 1000, currency: 'KRW' }, status: 'succeeded', kind: 'topup', period: null,
    occurredAt: clock.now(), failure: null,
  };
  await repo.payments.put(payment3);
  await ledger.append({
    customerId, pool: 'paid', kind: 'grant', amount: 100, unitPriceMinor: 10, currency: 'KRW', expiresAt: null,
    source: 'topup', reference: { paymentId: payment3.id }, idempotencyKey: `topup:${payment3.id}`, actor: 'system', reason: null,
  });
  const decision3 = await evaluate({ payment: payment3, policy, ledger, repo, clock }); // fresh payment -> D1
  const balanceBefore3 = (await ledger.balance(customerId, 'paid', clock.now())).available;

  let openedRefundFailedCase: { customerId: string; referenceId: string; reason: string; needs?: string } | null = null;
  const refund3 = await execute({
    decision: decision3, provider: new ReceiveAccountRequiredProvider(), ledger, repo, clock, ids,
    cs: { openRefundFailedCase: async (input) => { openedRefundFailedCase = input; } },
  });
  const balanceAfter3 = (await ledger.balance(customerId, 'paid', clock.now())).available;
  console.log('\n[execute #3, EC:D13 missing refundReceiveAccount]', JSON.stringify(refund3, null, 2));
  console.log('hold released, balance unchanged:', balanceBefore3, '->', balanceAfter3);
  console.log('cs.openRefundFailedCase received:', openedRefundFailedCase);

  console.log('\nsmoke: OK');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
