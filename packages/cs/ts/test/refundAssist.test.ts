// spec/cs.pseudo.md — EC:L5
// cs.refundAssist deliberately does NOT import `boilpayment-refund` (refundEvaluate/
// refundExecute are injected — see refundAssist.ts). This proves the wiring: the correlationId
// passed to refundAssist() reaches the injected refundExecute function unchanged.
import { describe, expect, it } from 'vitest';
import { DEFAULT_POLICY, FixedClock, InMemoryLedger, InMemoryRepo, SequentialIdGen, resolvePolicy } from 'boilpayment-core';
import type { Payment, PaymentProvider, ProviderCapabilities, Refund, RefundDecision } from 'boilpayment-core';
import { openCase, refundAssist } from '../src/index.js';
import type { RefundExecuteFn } from '../src/index.js';

const clock = new FixedClock(new Date('2026-01-01T00:00:00Z'));
const customerId = 'cust_1';

class FakeProvider implements PaymentProvider {
  readonly name = 'stripe' as const;
  capabilities(): ProviderCapabilities { return { nativeSubscriptions: true, partialRefund: true, meters: false, scheduling: 'provider', webhookSignature: true }; }
  async createCustomer(): Promise<{ ref: string }> { throw new Error('unused'); }
  async createCheckout(): Promise<never> { throw new Error('unused'); }
  async getPayment(): Promise<never> { throw new Error('unused'); }
  async listPayments() { return []; }
  async getSubscription(): Promise<never> { throw new Error('unused'); }
  async changeSubscription(): Promise<never> { throw new Error('unused'); }
  async cancelSubscription(): Promise<never> { throw new Error('unused'); }
  async chargeBillingKey(): Promise<never> { throw new Error('unused'); }
  async refund(): Promise<never> { throw new Error('unused: refundExecute is faked directly'); }
  async reportUsage() {}
  async verifyWebhook(): Promise<never> { throw new Error('unused'); }
}

describe('[EC:L5] cs.refundAssist threads correlationId to refundExecute', () => {
  it.each(['succeeded', 'failed', 'pending'] as const)('status %s: the correlationId passed to refundAssist reaches the injected refundExecute unchanged', async (status) => {
    const repo = new InMemoryRepo();
    const ledger = new InMemoryLedger(new SequentialIdGen('led_'));
    const ids = new SequentialIdGen('id_');
    const policy = DEFAULT_POLICY;

    const payment: Payment = {
      id: 'pay_assist_l5', customerId, provider: 'stripe', providerRef: 'pi_assist_l5', subscriptionId: null,
      amount: { amountMinor: 1000, currency: 'USD' }, status: 'succeeded', kind: 'topup', period: null,
      occurredAt: clock.now(), failure: null,
    };
    await repo.payments.put(payment);
    const csCase = await openCase({ customerId, kind: 'refund', referenceId: payment.id, policy, repo, clock, ids });

    const decision: RefundDecision = {
      eligible: true, amount: payment.amount, creditsToRevoke: 0, ruleId: 'D1', reason: 'test',
      needsHuman: false, paymentId: payment.id, customerId, subscriptionId: null,
    };
    const receivedCorrelationIds: (string | undefined)[] = [];
    const fakeRefundExecute: RefundExecuteFn = async (input) => {
      receivedCorrelationIds.push(input.correlationId);
      const refund: Refund = {
        id: 'rf_1', paymentId: payment.id, customerId, amount: payment.amount, status,
        providerRef: 'pref_1', creditsRevoked: 0, ruleId: 'D1', reason: null, failure: null, createdAt: clock.now(),
      };
      return refund;
    };

    const resolved = await refundAssist({
      case: csCase, payment, policy: resolvePolicy({ refund: { noQuestionsDays: 0 } }), ledger, repo, clock, ids, provider: new FakeProvider(),
      refundEvaluate: async (input) => { expect(input.policy).toEqual(csCase.policySnapshot); return decision; }, refundExecute: fakeRefundExecute,
      correlationId: 'corr_assist_1',
    });

    expect(resolved.status).toBe(status === 'succeeded' ? 'resolved_auto' : 'needs_human');
    expect(receivedCorrelationIds).toEqual(['corr_assist_1']);
  });
});
