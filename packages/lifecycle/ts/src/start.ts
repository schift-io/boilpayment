// spec: packages/lifecycle/spec/lifecycle.pseudo.md — EC:A65
// Start a self-scheduled subscription (Toss/PortOne) from a billing key the app just issued: the first
// period is charged through the same attempt path as renewals, then the subscription goes active and
// the period's credits are granted. Hosted-checkout providers (Stripe/Polar) start through checkout.
import { createHash } from 'node:crypto';
import { Clock, LedgerStore, Notifier, Payment, PaymentKitError, PaymentProvider, Plan, Policy, Repo, Subscription } from 'boilpayment-core';
import { chargeAttempt, renewalAttemptKey } from './charge-attempt.js';
import { requirePriceForSubscription } from './internal.js';
import { nextPeriod } from './period.js';
import { onRenewalPaid } from './renewal.js';

export interface StartSubscriptionInput {
  customerId: string;
  planId: string;
  currency: string;
  /** The billing key the provider issued (Toss `billing/authorizations/issue`, PortOne billing key). */
  billingKey: string;
  /** The provider customer key the billing key was issued under (Toss `customerKey`). Default: customerId. */
  customerRef?: string | null;
  /** The app's id for this sign-up; the same id never starts (or charges) twice. */
  requestId: string;
  provider: PaymentProvider;
  policy: Policy;
  ledger: LedgerStore;
  repo: Repo;
  clock: Clock;
  notifier?: Notifier;
  correlationId?: string;
}

export interface StartSubscriptionResult {
  sub: Subscription;
  payment: Payment;
}

/** EC:A65 — the subscription id for one sign-up request (found again on every retry). */
export function startedSubscriptionId(customerId: string, requestId: string): string {
  return 'sub_' + createHash('sha256').update(`start:${customerId}:${requestId}`).digest('hex').slice(0, 24);
}

/**
 * EC:A65 — the subscription row is written `incomplete` before the charge, so a retry with the same
 * requestId re-drives the same attempt (lookup first, EC:A49) instead of charging again. A declined
 * charge leaves it `incomplete` (the scheduler never charges it) and throws `subscription_start_declined`;
 * an unknown outcome throws `subscription_start_unresolved` — call again with the same requestId.
 */
export async function startSubscription(input: StartSubscriptionInput): Promise<StartSubscriptionResult> {
  const { provider, repo, clock, policy, ledger } = input;
  if (provider.capabilities().nativeSubscriptions) {
    throw new PaymentKitError(`${provider.name} subscriptions start through checkout`, 'use_checkout', { provider: provider.name });
  }
  const plan: Plan | null = await repo.plans.get(input.planId);
  if (!plan || plan.interval === null) throw new PaymentKitError(`not a subscription plan: ${input.planId}`, 'plan_not_found', { planId: input.planId });
  const customerRef = input.customerRef || input.customerId;
  await ensureCustomer(repo, clock, input.customerId, provider.name, customerRef);

  const id = startedSubscriptionId(input.customerId, input.requestId);
  let sub = await repo.subscriptions.get(id);
  if (sub && (sub.planId !== input.planId || sub.billingKey !== input.billingKey)) {
    throw new PaymentKitError('this requestId started a different subscription', 'idempotency_key_reused', { subscriptionId: id });
  }
  if (!sub) {
    const now = clock.now();
    const anchorDay = now.getUTCDate();
    const period = nextPeriod({ start: now, end: now }, plan.interval as 'month' | 'year', anchorDay, policy.period.timezone, policy.period.monthEndAnchor);
    const draft: Subscription = {
      id, customerId: input.customerId, planId: plan.id, provider: provider.name, providerRef: null, status: 'incomplete',
      currentPeriod: period, anchorDay, cancelAtPeriodEnd: false, graceUntil: null, billingKey: input.billingKey,
      billingCustomerRef: customerRef, scheduledPlanId: null, currency: input.currency, version: 0, createdAt: now,
    };
    requirePriceForSubscription(plan, draft); // a plan without a price in this currency is refused before any write
    await repo.subscriptions.put(draft);
    sub = (await repo.subscriptions.get(id)) as Subscription;
  }
  const price = requirePriceForSubscription(plan, sub);
  const outcome = await chargeAttempt({
    provider, repo, clock, sub, price, period: sub.currentPeriod, attemptKey: renewalAttemptKey(sub, sub.currentPeriod),
    correlationId: input.correlationId, notifier: input.notifier,
  });
  switch (outcome.kind) {
    case 'succeeded': {
      if (sub.status === 'active') return { sub, payment: outcome.payment };
      const paid = await onRenewalPaid({ sub, payment: { ...outcome.payment, period: sub.currentPeriod }, policy, ledger, repo, clock });
      // A retry after the grant was written but the activation was not: the grant is found, finish the write.
      const started = paid.sub.status === 'incomplete' ? { ...paid.sub, status: 'active' as const } : paid.sub;
      if (started !== paid.sub) await repo.subscriptions.put(started);
      return { sub: started, payment: outcome.payment };
    }
    case 'declined':
      throw new PaymentKitError('the first charge was declined', 'subscription_start_declined', { subscriptionId: id, payment: outcome.payment });
    case 'unresolved':
      throw new PaymentKitError('the first charge has no answer yet; call again with the same requestId', 'subscription_start_unresolved', { subscriptionId: id, reason: outcome.reason });
    case 'in_flight':
      throw new PaymentKitError('this sign-up is being charged right now', 'subscription_start_in_flight', { subscriptionId: id });
  }
}

async function ensureCustomer(repo: Repo, clock: Clock, customerId: string, provider: Subscription['provider'], ref: string): Promise<void> {
  const existing = await repo.customers.get(customerId);
  if (!existing) {
    await repo.customers.put({ id: customerId, email: null, providerRefs: [{ provider, ref }], status: 'active', createdAt: clock.now() });
    return;
  }
  // EC:A66 — a frozen (open dispute) or banned customer does not start a new subscription.
  if (existing.status !== 'active') throw new PaymentKitError(`customer is ${existing.status}`, `customer_${existing.status}`, { customerId });
  if (!existing.providerRefs.some((r) => r.provider === provider)) {
    await repo.customers.put({ ...existing, providerRefs: [...existing.providerRefs, { provider, ref }] });
  }
}
