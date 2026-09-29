import { FixedClock, PaymentKitError, runIdempotent } from 'boilpayment-core';
import { escalate, openCase } from './cases.js';
import { getPurchaseSnapshot, matchesCapturedSaleAmount } from './purchaseSnapshot.js';
import type { RecoverMissingGrantInput, SupportGrantOutcome } from './recoverMissingGrant.js';

export type ApplyPurchasedGrantInput = RecoverMissingGrantInput;

/** Initial fulfillment and recovery share captured sale facts and original credit grant keys. */
export async function applyPurchasedGrant(input: ApplyPurchasedGrantInput): Promise<SupportGrantOutcome> {
  const payment = await input.repo.payments.get(input.paymentId);
  const snapshot = await getPurchaseSnapshot({ paymentId: input.paymentId, repo: input.repo });
  if (!payment || !snapshot || snapshot.customerId !== input.customerId || payment.customerId !== input.customerId
    || snapshot.paymentRef !== payment.providerRef || snapshot.provider !== payment.provider
    || !matchesCapturedSaleAmount(snapshot, payment)
    || payment.status !== 'succeeded') throw new PaymentKitError('immutable purchase entitlement missing or inconsistent', 'purchase_evidence_missing');
  if (snapshot.plan.interval === null) {
    // EC:A85 — the payment remains evidence, but a banned customer cannot use the credits. Reuse
    // the top-up operation key so checkout registration and webhook redelivery share one case,
    // one notice and one no-grant result.
    const customer = await input.repo.customers.get(input.customerId);
    if (customer?.status === 'banned') {
      const withheld: SupportGrantOutcome = { entry: null, duplicated: false, deferred: true };
      const { result } = await runIdempotent({
        repo: input.repo, clock: input.clock, key: `topup:${payment.id}`, kind: 'credits.topup',
        payload: { customerId: input.customerId, paymentId: payment.id, credits: snapshot.plan.creditsPerPeriod,
          amountMinor: payment.amount.amountMinor, currency: payment.amount.currency },
        serialize: () => ({ ...withheld, offset: 0, offsetEntries: [] }),
        deserialize: () => withheld,
        fn: async () => {
          const reviews = await input.repo.csCases.list({ customerId: input.customerId, kind: 'refund', referenceId: payment.id });
          if (reviews.length === 0) {
            const review = await openCase({ customerId: input.customerId, kind: 'refund', referenceId: payment.id,
              policy: input.policy, repo: input.repo, clock: input.clock, ids: input.ids, onCaseEvent: input.onCaseEvent });
            await escalate({ case: review, reason: 'paid top-up belongs to a banned customer; refund review required',
              repo: input.repo, clock: input.clock, notifier: input.notifier, onCaseEvent: input.onCaseEvent });
          }
          return withheld;
        },
      });
      return result;
    }
    const clock = new FixedClock(new Date(snapshot.purchasedAt));
    return input.grants.topup({ customerId: input.customerId, payment, credits: snapshot.plan.creditsPerPeriod,
      policy: snapshot.policy, ledger: input.ledger, repo: input.repo, clock });
  }
  const clock = new FixedClock(new Date(snapshot.purchasedAt));
  const sub = snapshot.subscriptionId ? await input.repo.subscriptions.get(snapshot.subscriptionId) : null;
  if (!sub || sub.customerId !== input.customerId || sub.provider !== snapshot.provider || !snapshot.period) throw new PaymentKitError('subscription purchase evidence missing', 'purchase_evidence_missing');
  return input.grants.grantForPeriod({ sub, plan: snapshot.plan, period: { start: new Date(snapshot.period.start), end: new Date(snapshot.period.end) },
    payment, policy: snapshot.policy, ledger: input.ledger, clock });
}
