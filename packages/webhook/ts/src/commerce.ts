import { PaymentKitError, openZeroSaleCase, recordPaymentRefAliases, runIdempotent } from 'boilpayment-core';
import type {
  Clock,
  Money,
  Notifier,
  Payment,
  Plan,
  Policy,
  Repo,
  Subscription,
} from 'boilpayment-core';
import type { HandlerCtx } from './process.js';

export type LinkMismatchReason = 'missing_reference' | 'invalid_reference' | 'unknown_customer' | 'customer_inactive' | 'plan_unresolved';

export interface CommerceWebhookInput {
  readonly repo: Repo;
  readonly clock: Clock;
  readonly policy: Policy;
  /** DC-07 — told when a paid-zero sale opens its case; optional. */
  readonly notifier?: Notifier | null;
  readonly decodeLinkReference?: ((reference: string) => { readonly customerId: string; readonly affiliateId: string | null } | null) | null;
  readonly grantLinkPayment?: ((input: { readonly payment: Payment; readonly plan: Plan; readonly subscription: Subscription | null }) => Promise<void>) | null;
  readonly openLinkMismatchCase?: ((input: { readonly payment: Payment; readonly reason: LinkMismatchReason }) => Promise<void>) | null;
  readonly commissionForPayment?: ((payment: Payment) => Promise<Money | null>) | null;
  readonly resolveLocalPayment: (ctx: HandlerCtx, providerRef: string) => Promise<Payment>;
  readonly markUnknownProviderRef: (kind: 'payment', providerRef: string, providerName: string) => Promise<never>;
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

export function createCommerceWebhook(input: CommerceWebhookInput) {
  const { repo, clock, policy } = input;

  async function accrueAffiliate(payment: Payment, affiliateId: string | null): Promise<void> {
    if (!affiliateId || !input.commissionForPayment) return;
    const amount = await input.commissionForPayment(payment);
    if (!amount || amount.amountMinor <= 0) return;
    await repo.affiliateCommissions.append({
      id: `affiliate-accrual:${payment.id}`, kind: 'accrual', affiliateId, paymentId: payment.id,
      refundId: null, relatedAccrualId: null, amount,
      idempotencyKey: `affiliate:${payment.id}:accrual`, createdAt: clock.now(),
    });
  }

  async function openLinkMismatch(payment: Payment, reason: LinkMismatchReason): Promise<void> {
    await runIdempotent({
      repo, key: `payment-link-mismatch:${payment.id}`, kind: 'payment_link.mismatch',
      payload: { paymentId: payment.id, reason }, clock,
      fn: async () => {
        if (input.openLinkMismatchCase) {
          await input.openLinkMismatchCase({ payment, reason });
        } else {
          const now = clock.now();
          await repo.csCases.put({
            id: `payment-link:${payment.id}`, customerId: payment.customerId, kind: 'reconcile_mismatch',
            status: 'needs_human', referenceId: payment.id, policySnapshot: structuredClone(policy),
            decision: { reason, paymentId: payment.id }, churnReason: null, churnText: null,
            openedAt: now, resolvedAt: null, escalatedAt: now,
          });
        }
        return { paymentId: payment.id };
      },
    });
  }

  function checkoutSnapshot(value: unknown): { customerId: string; kind: Payment['kind']; affiliateId: string | null } | null {
    const snapshot = record(value);
    const plan = record(snapshot?.['plan']);
    const customerId = snapshot?.['customerId'] ?? snapshot?.['customer_id'];
    const planId = plan?.['id'];
    const affiliateId = snapshot?.['affiliateId'] ?? snapshot?.['affiliate_id'] ?? null;
    return typeof customerId === 'string' && typeof planId === 'string'
      && (affiliateId === null || typeof affiliateId === 'string')
      ? { customerId, kind: plan?.['interval'] === null ? 'topup' : 'subscription', affiliateId }
      : null;
  }

  async function recordPayment(remote: Payment, customerId: string, kind: Payment['kind'], subscriptionId: string | null, affiliateId: string | null): Promise<Payment> {
    const id = `payment:${remote.provider}:${remote.providerRef}`;
    const existing = await repo.payments.get(id);
    if (existing) return existing;
    const payment: Payment = { ...remote, id, customerId, subscriptionId, kind, affiliateId, cashReceipt: remote.cashReceipt ?? null };
    await repo.payments.put(payment);
    await recordPaymentRefAliases(repo, payment, remote.providerRefAliases ?? [], clock.now());
    return payment;
  }

  async function resolvePlan(provider: Payment['provider'], priceRef: string | null): Promise<Plan | null> {
    if (!priceRef) return null;
    const matched = (await repo.plans.list()).filter((plan) =>
      plan.prices.some((price) => price.providerPriceRefs?.[provider] === priceRef));
    return matched.length === 1 ? matched[0] ?? null : null;
  }

  // OT-09 — a Stripe PaymentIntent carries the kit's checkout key, not the session id.
  async function checkoutIdFromMetadata(remote: Payment): Promise<string | null> {
    const metadata = record(record(remote.raw)?.['metadata']);
    const key = metadata?.['checkoutEntitlementKey'];
    if (typeof key !== 'string' || !key) return null;
    const pointer = await repo.operations.get(`checkout-id-by-key:${key}`);
    const checkoutId = pointer?.status === 'done' ? record(pointer.result)?.['checkoutId'] : null;
    return typeof checkoutId === 'string' ? checkoutId : null;
  }

  async function holdCheckout(remote: Payment, checkoutId: string): Promise<Payment | null | undefined> {
    const operation = await repo.operations.get(`checkout-entitlement-by-id:${checkoutId}`);
    const snapshot = operation?.kind === 'checkout.entitlement' && operation.status === 'done'
      ? checkoutSnapshot(operation.result) : null;
    if (!snapshot) return undefined;
    const payment = await recordPayment(remote, snapshot.customerId, snapshot.kind, null, remote.affiliateId ?? snapshot.affiliateId);
    const purchase = await repo.operations.get(`purchase-entitlement:${payment.id}`);
    if (purchase?.kind === 'purchase.entitlement' && purchase.status === 'done') return payment;
    await runIdempotent({
      repo, key: `checkout-payment-held:${payment.id}`, kind: 'checkout.paymentHeld',
      payload: { paymentId: payment.id, checkoutId, customerId: snapshot.customerId }, clock,
      fn: async () => ({ paymentId: payment.id, checkoutId, customerId: snapshot.customerId, receivedAt: clock.now().toISOString() }),
    });
    return null;
  }

  const isFreeTrialPlan = (plan: { readonly interval: unknown; readonly trialDays?: unknown }): boolean =>
    plan.interval !== null && typeof plan.trialDays === 'number' && plan.trialDays > 0;

  // DC-07 — a paid-zero sale that is not a trial: record it, grant nothing, open one case.
  async function handleZeroCheckoutSale(remote: Payment, checkoutId: string): Promise<boolean> {
    const operation = await repo.operations.get(`checkout-entitlement-by-id:${checkoutId}`);
    if (operation?.kind !== 'checkout.entitlement' || operation.status !== 'done') return false;
    const snapshot = checkoutSnapshot(operation.result);
    if (!snapshot) return false;
    if (snapshot.kind === 'subscription' && isFreeTrialPlan({ interval: 'x', trialDays: record(record(operation.result)?.['plan'])?.['trialDays'] })) return false;
    const payment = await recordPayment(remote, snapshot.customerId, snapshot.kind, null, remote.affiliateId ?? snapshot.affiliateId);
    await openZeroSaleCase({ repo, clock, policy, payment, notifier: input.notifier });
    return true;
  }

  async function handlePaymentLink(ctx: HandlerCtx, remote: Payment): Promise<null> {
    const evidence = remote.saleEvidence;
    const identifiedLink = Boolean(evidence?.paymentLinkId)
      || (ctx.provider.name === 'polar' && Boolean(evidence?.priceRef));
    if (!evidence || !identifiedLink) return input.markUnknownProviderRef('payment', remote.providerRef, ctx.provider.name);
    const missingReference = !evidence.linkReference;
    const decoded = evidence.linkReference && input.decodeLinkReference ? input.decodeLinkReference(evidence.linkReference) : null;
    const existingCustomer = decoded ? await repo.customers.get(decoded.customerId) : null;
    const plan = await resolvePlan(ctx.provider.name, evidence.priceRef);
    const reason: LinkMismatchReason | null = missingReference ? 'missing_reference'
      : !decoded ? 'invalid_reference' : !existingCustomer ? 'unknown_customer'
        : existingCustomer.status !== 'active' ? 'customer_inactive' : !plan ? 'plan_unresolved' : null;
    const unmatchedCustomerId = `unmatched-link:${ctx.provider.name}:${remote.providerRef}`;
    const customerId = existingCustomer && decoded ? decoded.customerId : unmatchedCustomerId;
    if (!existingCustomer) {
      await repo.customers.put({ id: customerId, email: null, providerRefs: [], status: 'frozen', createdAt: clock.now() });
    }
    if (reason || !decoded || !plan) {
      const payment = await recordPayment(remote, customerId, remote.kind, null, decoded?.affiliateId ?? remote.affiliateId ?? null);
      await openLinkMismatch(payment, reason ?? 'plan_unresolved');
      return null;
    }

    const affiliateId = decoded.affiliateId ?? remote.affiliateId ?? null;
    if (remote.amount.amountMinor === 0 && !isFreeTrialPlan(plan)) {
      const zero = await recordPayment(remote, customerId, plan.interval === null ? 'topup' : 'subscription', null, affiliateId);
      await openZeroSaleCase({ repo, clock, policy, payment: zero, notifier: input.notifier });
      return null;
    }
    let subscription: Subscription | null = null;
    if (plan.interval !== null) {
      const subscriptionRef = ctx.event.subscriptionRef ?? remote.subscriptionId;
      if (!subscriptionRef) {
        const payment = await recordPayment(remote, customerId, 'subscription', null, affiliateId);
        await openLinkMismatch(payment, 'plan_unresolved');
        return null;
      }
      const id = `subscription:${ctx.provider.name}:${subscriptionRef}`;
      subscription = await repo.subscriptions.get(id);
      if (!subscription) {
        const providerSub = await ctx.provider.getSubscription(subscriptionRef);
        subscription = await repo.subscriptions.put({
          ...providerSub, id, customerId, planId: plan.id, provider: ctx.provider.name,
          providerRef: subscriptionRef, currency: remote.amount.currency, affiliateId,
        });
      }
    }
    const payment = await recordPayment(remote, customerId, plan.interval === null ? 'topup' : 'subscription', subscription?.id ?? null, affiliateId);
    await runIdempotent({
      repo, key: `payment-link-grant:${payment.id}`, kind: 'payment_link.grant',
      payload: { paymentId: payment.id, planId: plan.id }, clock,
      fn: async () => {
        if (!input.grantLinkPayment) throw new PaymentKitError('payment-link grant callback missing', 'payment_link_grant_unavailable');
        await input.grantLinkPayment({ payment, plan, subscription });
        await accrueAffiliate(payment, affiliateId);
        return { paymentId: payment.id, planId: plan.id };
      },
    });
    return null;
  }

  async function handleUnregisteredPayment(ctx: HandlerCtx, requestedRef: string): Promise<Payment | null> {
    if (ctx.provider.name !== 'stripe' && ctx.provider.name !== 'polar') {
      return input.markUnknownProviderRef('payment', requestedRef, ctx.provider.name);
    }
    const remote = await ctx.provider.getPayment(requestedRef);
    const canonical = await repo.payments.list({ provider: ctx.provider.name, providerRef: remote.providerRef } as Partial<Payment>);
    if (canonical[0]) return input.resolveLocalPayment(ctx, remote.providerRef);
    if (remote.status !== 'succeeded') {
      throw new PaymentKitError('Top-up payment has not succeeded', 'topup_payment_not_succeeded', {
        paymentId: remote.id,
        status: remote.status,
      });
    }
    const checkoutId = remote.saleEvidence?.checkoutId ?? await checkoutIdFromMetadata(remote);
    if (checkoutId && remote.amount.amountMinor === 0 && await handleZeroCheckoutSale(remote, checkoutId)) return null;
    if (checkoutId) {
      const held = await holdCheckout(remote, checkoutId);
      if (held !== undefined) return held;
    }
    return handlePaymentLink(ctx, remote);
  }

  // A redelivery for a payment whose link grant (or link mismatch case) started and did not finish
  // runs the link path again; a known link payment has no purchase snapshot, so the top-up branch
  // could never complete it.
  async function retryIncompleteLink(ctx: HandlerCtx, payment: Payment): Promise<boolean> {
    const grant = await repo.operations.get(`payment-link-grant:${payment.id}`);
    const mismatch = await repo.operations.get(`payment-link-mismatch:${payment.id}`);
    const pending = (grant?.kind === 'payment_link.grant' && grant.status !== 'done')
      || (mismatch?.kind === 'payment_link.mismatch' && mismatch.status !== 'done');
    if (!pending) return false;
    const remote = await ctx.provider.getPayment(payment.providerRef);
    if (remote.status !== 'succeeded') {
      throw new PaymentKitError('Top-up payment has not succeeded', 'topup_payment_not_succeeded', {
        paymentId: payment.id,
        status: remote.status,
      });
    }
    await handlePaymentLink(ctx, remote);
    return true;
  }

  return { accrueAffiliate, handleUnregisteredPayment, retryIncompleteLink };
}
