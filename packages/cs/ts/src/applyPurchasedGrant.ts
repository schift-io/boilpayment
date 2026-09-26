import { FixedClock, PaymentKitError } from '@schift/payment-kit-core';
import { getPurchaseSnapshot } from './purchaseSnapshot.js';
import type { RecoverMissingGrantInput, SupportGrantOutcome } from './recoverMissingGrant.js';

export type ApplyPurchasedGrantInput = RecoverMissingGrantInput;

/** Initial fulfillment and recovery share captured sale facts and original credit grant keys. */
export async function applyPurchasedGrant(input: ApplyPurchasedGrantInput): Promise<SupportGrantOutcome> {
  const payment = await input.repo.payments.get(input.paymentId);
  const snapshot = await getPurchaseSnapshot({ paymentId: input.paymentId, repo: input.repo });
  if (!payment || !snapshot || snapshot.customerId !== input.customerId || payment.customerId !== input.customerId
    || snapshot.paymentRef !== payment.providerRef || snapshot.provider !== payment.provider
    || snapshot.price.amountMinor !== payment.amount.amountMinor || snapshot.price.currency !== payment.amount.currency
    || payment.status !== 'succeeded') throw new PaymentKitError('immutable purchase entitlement missing or inconsistent', 'purchase_evidence_missing');
  const clock = new FixedClock(new Date(snapshot.purchasedAt));
  if (snapshot.plan.interval === null) return input.grants.topup({ customerId: input.customerId, payment, credits: snapshot.plan.creditsPerPeriod,
    policy: snapshot.policy, ledger: input.ledger, repo: input.repo, clock });
  const sub = snapshot.subscriptionId ? await input.repo.subscriptions.get(snapshot.subscriptionId) : null;
  if (!sub || sub.customerId !== input.customerId || sub.provider !== snapshot.provider || !snapshot.period) throw new PaymentKitError('subscription purchase evidence missing', 'purchase_evidence_missing');
  return input.grants.grantForPeriod({ sub, plan: snapshot.plan, period: { start: new Date(snapshot.period.start), end: new Date(snapshot.period.end) },
    payment, policy: snapshot.policy, ledger: input.ledger, clock });
}
