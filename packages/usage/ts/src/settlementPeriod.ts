import { PaymentKitError } from 'boilpayment-core';
import type { Period, Repo, Subscription } from 'boilpayment-core';

/** Require one subscription and an original billing-period snapshot before settling money. */
export async function settlementPeriod(repo: Repo, sub: Subscription, period: Period): Promise<string | undefined> {
  const subscriptions = await repo.subscriptions.list({ customerId: sub.customerId });
  if (subscriptions.some((candidate) => candidate.id !== sub.id)) {
    throw new PaymentKitError('Customer usage cannot identify one subscription', 'ambiguous_usage_subscription');
  }
  const payments = (await repo.payments.list({ subscriptionId: sub.id })).filter((payment) =>
    payment.customerId === sub.customerId && payment.period?.start.getTime() === period.start.getTime() &&
    (payment.kind === 'overage' || payment.kind === 'subscription' && payment.status === 'succeeded'));
  if (payments.some((payment) => payment.period?.end.getTime() !== period.end.getTime())) {
    throw new PaymentKitError('Usage period conflicts with its original payment', 'invalid_usage_period');
  }
  if (period.start.getTime() === sub.currentPeriod.start.getTime()) {
    if (period.end.getTime() !== sub.currentPeriod.end.getTime()) throw new PaymentKitError('Usage period end is not canonical', 'invalid_usage_period');
  } else if (!payments.length) {
    throw new PaymentKitError('Historical usage requires an original payment period', 'invalid_usage_period');
  }
  const currencies = [...new Set(payments.map((payment) => payment.amount.currency))];
  if (currencies.length > 1) throw new PaymentKitError('Original usage currency is ambiguous', 'billing_currency_required');
  return currencies[0];
}
