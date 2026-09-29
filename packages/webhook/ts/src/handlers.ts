import { authoritativeRefundEvent } from './refund.js';
// EC:E3 — duck-typed handler wiring. lifecycle/credits/refund/cs are built
// concurrently and are NOT imported here — callers inject whatever satisfies
// these shapes (real package or fake). See spec/webhook.pseudo.md.
//
// EC:E3 identity rule (2026-09-09, per team-lead): provider.getPayment /
// getSubscription re-fetches are re-verification only — they confirm live
// status/period/amount, but their id/customerId/planId/subscriptionId fields
// are provider-adapter best-effort (restored from checkout metadata) and are
// NOT trustworthy local identity. The entity passed to lifecycle/credits is
// always the local repo row (found by providerRef), with only the verified
// live fields overlaid on top. If no local row matches providerRef (e.g. a
// subscription created directly in the provider dashboard), we do not
// process the event: the webhook record is left 'failed' with error
// 'unknown_provider_ref' and a 'reconcile.mismatch' notification is sent —
// see markUnknownProviderRef() below.
import {
  INACTIVE_SUBSCRIPTION_STATUSES,
  PaymentKitError,
  expectedAttemptAmount,
  holdAttemptForReview,
  isClosedByPerson,
  isUnderReview,
  isZeroSaleHandled,
  lookupMismatch,
  openZeroSaleCase,
  recordPaymentRefAliases,
  runIdempotent,
} from 'boilpayment-core';
import { localizePaymentEvent } from './payment-ref.js';
import type {
  CashReceiptType, Clock, CsCase, IdGen, LedgerStore, Money, Notifier, Payment, PaymentProvider, Plan, Policy, Repo, Subscription,
} from 'boilpayment-core';
import type { Handler, HandlerCtx, HandlerMap } from './process.js';
import { withCorrelationId } from './correlation.js';
import { createCommerceWebhook } from './commerce.js';
import type { LinkMismatchReason } from './commerce.js';

// EC:K1 call-site helper — deliberately duplicated from packages/lifecycle/ts/src/retry.ts rather
// than imported: this package intentionally does NOT depend on boilpayment-lifecycle (see
// the EC:E3 duck-typing note above), and adding that edge just for this ~15-line helper would
// break that boundary. Retries `fn` when it throws PaymentKitError('subscription_version_conflict')
// (thrown by Repo.subscriptions.put — see EC:K1), up to `attempts` times; `fn` re-reads whatever
// Subscription it needs on every attempt.
async function retryOnVersionConflict<T>(fn: () => Promise<T>, attempts = 3): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof PaymentKitError && err.code === 'subscription_version_conflict') {
        lastErr = err;
        continue;
      }
      throw err;
    }
  }
  throw lastErr;
}

type CheckoutSubscriptionIdentity = {
  readonly customerId: string;
  readonly planId: string;
  readonly provider: Subscription['provider'];
  readonly currency: string;
};

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function stripeCheckoutSessionId(raw: unknown): string | null {
  const event = record(raw);
  const data = record(event?.['data']);
  const session = record(data?.['object']);
  return event?.['type'] === 'checkout.session.completed'
    && session?.['mode'] === 'subscription'
    && typeof session['id'] === 'string'
    ? session['id']
    : null;
}

function checkoutSubscriptionIdentity(value: unknown): CheckoutSubscriptionIdentity | null {
  const snapshot = record(value);
  const plan = record(snapshot?.['plan']);
  const price = record(snapshot?.['price']);
  const customerId = snapshot?.['customerId'] ?? snapshot?.['customer_id'];
  const planId = plan?.['id'];
  const provider = snapshot?.['provider'];
  const currency = price?.['currency'];
  return typeof customerId === 'string'
    && typeof planId === 'string'
    && provider === 'stripe'
    && typeof currency === 'string'
    ? { customerId, planId, provider, currency }
    : null;
}

export interface LifecycleDeps {
  onRenewalPaid(input: { sub: Subscription; payment: Payment; policy: Policy; ledger: LedgerStore; repo: Repo; clock: Clock }): Promise<unknown>;
  dunning: {
    onPaymentFailed(input: { sub: Subscription; policy: Policy; ledger: LedgerStore; repo: Repo; notifier: Notifier; clock: Clock }): Promise<unknown>;
  };
}
export interface CreditsDeps {
  // EC:B10 J1-J5 — `repo` is threaded through so the real credits.topup() can wrap the grant in
  // runIdempotent (packages/core) the same way every other webhook-triggered mutation is:
  // otherwise a redelivered `payment.succeeded` for a one-time payment only gets ledger-level
  // idempotency_key dedup (B12), not the operation-level in-progress/replay guarantees (J1-J3).
  topup(input: { customerId: string; payment: Payment; credits: number; policy: Policy; ledger: LedgerStore; clock: Clock; repo: Repo }): Promise<unknown>;
}
export interface RefundDeps {
  onExternalRefund(input: { event: HandlerCtx['event']; ledger: LedgerStore; repo: Repo; cs?: CsDeps | null }): Promise<unknown>;
}
export interface CsDeps {
  dispute(input: { event: HandlerCtx['event']; policy: Policy; ledger: LedgerStore; repo: Repo; notifier: Notifier; provider?: PaymentProvider }): Promise<unknown>;
}

// EC:K2-K7 — duck-typed against TossProvider/PortoneProvider's `issueCashReceipt` extra method
// (not part of core PaymentProvider — Stripe/Polar don't have one). Mirrors the
// `CashReceiptCanceler` duck-type in packages/refund/ts/src/execute.ts.
interface CashReceiptIssuer {
  issueCashReceipt(input: {
    paymentRef: string;
    type: CashReceiptType;
    customerIdentityNumber: string;
    orderName?: string;
    taxFreeAmountMinor?: number;
  }): Promise<{ receiptKey: string; type: CashReceiptType }>;
}

export interface DefaultHandlersInput {
  policy: Policy;
  ledger: LedgerStore;
  repo: Repo;
  notifier: Notifier;
  clock: Clock;
  ids: IdGen;
  lifecycle?: LifecycleDeps | null;
  credits?: CreditsDeps | null;
  refund?: RefundDeps | null;
  cs?: CsDeps | null;
  /** One-time payment → how many credits it buys (look up the plan/price the app sold). Required for top-ups. */
  resolveTopupCredits?: ((payment: Payment) => Promise<number | null>) | null;
  /**
   * EC:K2 — required (together with a cash-receipt-capable provider) for `policy.cashReceipt.mode
   * === 'auto'` to actually issue anything. The kit has no source for a customer's phone number /
   * 사업자등록번호 (not on `Customer` or `Payment`) — the app resolves it (e.g. collected at
   * checkout, or from its own customer record). Return `null` to skip issuance for this payment
   * (e.g. a non-KR customer, or one who declined a receipt). `type` defaults to
   * `policy.cashReceipt.defaultType` when omitted.
   */
  resolveCashReceiptIdentity?: ((payment: Payment) => Promise<{ customerIdentityNumber: string; type?: CashReceiptType } | null>) | null;
  /** EC:K6 — called (in addition to a 'reconcile.mismatch' notification) when issuance fails; failure never rolls back the payment. */
  onCashReceiptError?: ((input: { payment: Payment; error: unknown }) => void | Promise<void>) | null;
  /** Decode the provider-safe customer/affiliate reference emitted by the payment-link helper. */
  decodeLinkReference?: ((reference: string) => { readonly customerId: string; readonly affiliateId: string | null } | null) | null;
  /** Grant a provider payment-link purchase under the current plan terms. */
  grantLinkPayment?: ((input: { readonly payment: Payment; readonly plan: Plan; readonly subscription: Subscription | null }) => Promise<void>) | null;
  /** Open the operator case for an unmatched payment link. The handler invokes this exactly once. */
  openLinkMismatchCase?: ((input: { readonly payment: Payment; readonly reason: LinkMismatchReason }) => Promise<void>) | null;
  /** Whether payments after the affiliate-attributed first subscription payment also accrue. */
  affiliateRenewals?: 'first_only' | 'include';
  /** User/config-resolved commission amount. Null means no accrual. */
  commissionForPayment?: ((payment: Payment) => Promise<Money | null>) | null;
}

export function defaultHandlers(input: DefaultHandlersInput): HandlerMap {
  const { policy, ledger, repo, notifier, clock, ids, lifecycle, credits, refund, cs } = input;

  // Not-found local entity for a webhook's providerRef -> notify + fail the record (caught by process()).
  async function markUnknownProviderRef(kind: 'subscription' | 'payment', providerRef: string, providerName: string): Promise<never> {
    await notifier.send({ type: 'reconcile.mismatch', customerId: null, payload: { kind, providerRef, provider: providerName } });
    throw new Error('unknown_provider_ref');
  }

  async function resolveLocalSubscription(ctx: HandlerCtx, providerRef: string, preserveCurrentPeriod = false): Promise<Subscription> {
    const subs = await repo.subscriptions.list({ providerRef } as Partial<Subscription>);
    if (subs.length === 0) return markUnknownProviderRef('subscription', providerRef, ctx.provider.name);
    let sub = subs[0];
    // EC:F — Toss/PortOne have no native provider-side subscription (self-scheduled by us);
    // getSubscription() throws PaymentKitError('unsupported') there, so only re-fetch when supported.
    if (ctx.provider.capabilities().nativeSubscriptions) {
      const providerSub = await ctx.provider.getSubscription(providerRef); // re-fetch for verification (EC:E3)
      sub = { ...sub, status: providerSub.status, currentPeriod: preserveCurrentPeriod ? sub.currentPeriod : providerSub.currentPeriod, cancelAtPeriodEnd: providerSub.cancelAtPeriodEnd, graceUntil: providerSub.graceUntil };
    }
    return sub;
  }

  async function resolveLocalPayment(ctx: HandlerCtx, providerRef: string): Promise<Payment> {
    const payments = await repo.payments.list({ providerRef } as Partial<Payment>);
    if (payments.length === 0) return markUnknownProviderRef('payment', providerRef, ctx.provider.name);
    const providerPayment = await ctx.provider.getPayment(providerRef); // re-fetch for verification (EC:E3)
    await recordPaymentRefAliases(repo, payments[0], providerPayment.providerRefAliases ?? [], clock.now()); // EC:E24
    return {
      ...payments[0],
      providerRef: providerPayment.providerRef,
      status: providerPayment.status,
      amount: providerPayment.amount,
      period: providerPayment.period,
      occurredAt: providerPayment.occurredAt,
      failure: providerPayment.failure,
      raw: providerPayment.raw,
      saleEvidence: providerPayment.saleEvidence ?? payments[0].saleEvidence ?? null,
      affiliateId: providerPayment.affiliateId ?? payments[0].affiliateId ?? null,
    };
  }

  // EC:E16 — a native provider (Stripe/Polar) renews on its own schedule, so the renewal invoice
  // reaches us first as a webhook: no local Payment row exists for it yet. When the event names a
  // subscription we already have, re-fetch the payment from the provider (EC:E3), check that the
  // provider ties it to that same subscription, and record it before renewing. Anything else keeps
  // the unknown_provider_ref path.
  async function resolveRenewalPayment(ctx: HandlerCtx, paymentRef: string, subscriptionRef: string): Promise<Payment> {
    if ((await repo.payments.list({ providerRef: paymentRef } as Partial<Payment>)).length > 0) return resolveLocalPayment(ctx, paymentRef);
    const [sub] = await repo.subscriptions.list({ provider: ctx.provider.name, providerRef: subscriptionRef } as Partial<Subscription>);
    if (!sub || !ctx.provider.capabilities().nativeSubscriptions) return resolveLocalPayment(ctx, paymentRef);
    const remote = await ctx.provider.getPayment(paymentRef);
    if (remote.kind !== 'subscription' || remote.subscriptionId !== subscriptionRef) {
      return markUnknownProviderRef('payment', paymentRef, ctx.provider.name);
    }
    // A concurrent delivery of the same invoice may have recorded it since the first lookup.
    const [raced] = await repo.payments.list({ providerRef: paymentRef } as Partial<Payment>);
    if (raced) return raced;
    const recorded = await repo.payments.put({
      id: ids.newId(), customerId: sub.customerId, provider: ctx.provider.name, providerRef: remote.providerRef, subscriptionId: sub.id,
      amount: remote.amount, status: remote.status, kind: 'subscription', period: remote.period, occurredAt: remote.occurredAt,
      failure: remote.failure, cashReceipt: null, raw: remote.raw, saleEvidence: remote.saleEvidence ?? null,
      affiliateId: sub.affiliateId ?? remote.affiliateId ?? null,
    });
    await recordPaymentRefAliases(repo, recorded, remote.providerRefAliases ?? [], clock.now()); // EC:E24
    return recorded;
  }

  async function parkLateRenewal(sub: Subscription, payment: Payment): Promise<void> {
    // SB-10 — money arriving after local expiry/cancellation is evidence to reconcile, never a
    // reason to revive access or grant credits. Operation claiming makes both the case and notice
    // exactly-once across distinct provider event IDs for the same payment.
    await runIdempotent({
      repo,
      key: `webhook.late-renewal:${payment.id}`,
      kind: 'webhook.late_renewal',
      payload: { paymentId: payment.id, subscriptionId: sub.id },
      clock,
      fn: async () => {
        const existing = await repo.csCases.list({
          customerId: sub.customerId,
          kind: 'reconcile_mismatch',
          referenceId: payment.id,
        } as Partial<CsCase>);
        const active = existing.find((csCase) => csCase.status === 'open' || csCase.status === 'needs_human');
        if (active) return { caseId: active.id };

        const now = clock.now();
        const csCase: CsCase = {
          id: `late-renewal:${payment.id}`,
          customerId: sub.customerId,
          kind: 'reconcile_mismatch',
          status: 'needs_human',
          referenceId: payment.id,
          policySnapshot: structuredClone(policy),
          decision: { reason: 'late renewal payment for closed subscription', paymentId: payment.id },
          churnReason: null,
          churnText: null,
          openedAt: now,
          resolvedAt: null,
          escalatedAt: now,
        };
        await repo.csCases.put(csCase);
        await notifier.send({
          type: 'cs.needs_human',
          customerId: sub.customerId,
          payload: { caseId: csCase.id, kind: csCase.kind, reason: 'late renewal payment for closed subscription', paymentId: payment.id },
        });
        return { caseId: csCase.id };
      },
    });
  }

  // EC:K2 K4 K6 K7 — issue a cash receipt for a succeeded payment when policy.cashReceipt.mode ===
  // 'auto'. K4 (card-payment exclusion) is enforced by the provider adapter itself (Toss/PortOne's
  // issueCashReceipt throws PaymentKitError('cash_receipt_unsupported_for_payment_method') before
  // ever calling the provider API — see toss/portone src); that specific failure is EXPECTED for
  // every card payment once auto mode is on, so it's swallowed quietly here rather than notified —
  // anything else is a genuine failure and gets reported.
  async function maybeIssueCashReceipt(payment: Payment, provider: PaymentProvider): Promise<void> {
    if (policy.cashReceipt.mode !== 'auto') return;
    if (payment.cashReceipt) return; // EC:K7 — already issued; a webhook redelivery must not double-issue
    if (!input.resolveCashReceiptIdentity) return;
    const issuer = provider as unknown as Partial<CashReceiptIssuer>;
    if (typeof issuer.issueCashReceipt !== 'function') return; // provider has no cash-receipt support (duck-type)

    try {
      const identity = await input.resolveCashReceiptIdentity(payment);
      if (!identity) return; // app opted this payment out (non-KR customer, declined, etc.)
      const type = identity.type ?? policy.cashReceipt.defaultType;
      const receipt = await issuer.issueCashReceipt({
        paymentRef: payment.providerRef,
        type,
        customerIdentityNumber: identity.customerIdentityNumber,
      });
      // EC:K7 — re-fetch immediately before writing so this doesn't clobber any other field a
      // concurrent write to the same Payment row changed since `payment` was resolved.
      const fresh = (await repo.payments.get(payment.id)) ?? payment;
      await repo.payments.put({
        ...fresh,
        cashReceipt: { receiptKey: receipt.receiptKey, issuedAt: clock.now(), type: receipt.type ?? type },
      });
    } catch (err) {
      if (err instanceof PaymentKitError && err.code === 'cash_receipt_unsupported_for_payment_method') return; // EC:K4 — expected, not an incident
      // EC:K6 — any other issuance failure never rolls back payment processing (the payment itself
      // already succeeded). Record + notify, then continue.
      await notifier.send({
        type: 'cs.needs_human',
        customerId: payment.customerId,
        payload: { kind: 'cash_receipt_issue_failed', paymentId: payment.id, error: err instanceof Error ? err.message : String(err) },
      });
      if (input.onCashReceiptError) await input.onCashReceiptError({ payment, error: err });
    }
  }

  const commerce = createCommerceWebhook({
    repo,
    clock,
    policy,
    notifier,
    decodeLinkReference: input.decodeLinkReference,
    grantLinkPayment: input.grantLinkPayment,
    openLinkMismatchCase: input.openLinkMismatchCase,
    commissionForPayment: input.commissionForPayment,
    resolveLocalPayment,
    markUnknownProviderRef,
  });
  const onPaymentSucceeded: Handler = async (ctx) => {
    // EC:L5 — every ledger append lifecycle/credits make while handling THIS delivery gets
    // ctx.correlationId merged into its reference, without lifecycle/credits knowing correlationId
    // exists (see correlation.ts doc comment).
    const scopedLedger = withCorrelationId(ledger, ctx.correlationId);
    const paymentRef = ctx.event.paymentRef;
    if (!paymentRef) throw new PaymentKitError('Payment reference is missing', 'payment_reference_missing');
    const knownPayments = await repo.payments.list({ provider: ctx.provider.name, providerRef: paymentRef } as Partial<Payment>);
    const knownSubscriptions = ctx.event.subscriptionRef
      ? await repo.subscriptions.list({ provider: ctx.provider.name, providerRef: ctx.event.subscriptionRef } as Partial<Subscription>)
      : [];
    const payment = knownPayments.length > 0
      ? await resolveLocalPayment(ctx, paymentRef)
      : ctx.event.subscriptionRef && knownSubscriptions.length > 0
        ? await resolveRenewalPayment(ctx, paymentRef, ctx.event.subscriptionRef)
        : await commerce.handleUnregisteredPayment(ctx, paymentRef);
    if (!payment) return;
    if (await isZeroSaleHandled(repo, payment.id)) return; // DC-07 — recorded, nothing granted, case already open
    if (knownPayments.length > 0 && await commerce.retryIncompleteLink(ctx, payment)) return;
    const linkGrant = await repo.operations.get(`payment-link-grant:${payment.id}`);
    if (linkGrant?.kind === 'payment_link.grant' && linkGrant.status === 'done') return;
    const linkMismatch = await repo.operations.get(`payment-link-mismatch:${payment.id}`);
    if (linkMismatch?.kind === 'payment_link.mismatch' && linkMismatch.status === 'done') return;
    const heldCheckout = await repo.operations.get(`checkout-payment-held:${payment.id}`);
    const registeredCheckout = await repo.operations.get(`purchase-entitlement:${payment.id}`);
    if (heldCheckout?.kind === 'checkout.paymentHeld' && heldCheckout.status === 'done'
      && !(registeredCheckout?.kind === 'purchase.entitlement' && registeredCheckout.status === 'done')) return;
    if (ctx.event.subscriptionRef) {
      // SB-10 — inspect the stored status before resolveLocalSubscription overlays provider state.
      // A provider-side active status after local expiry/cancellation must not resurrect entitlement.
      const [storedSub] = await repo.subscriptions.list({
        provider: ctx.provider.name,
        providerRef: ctx.event.subscriptionRef,
      } as Partial<Subscription>);
      if (storedSub && (storedSub.status === 'expired' || storedSub.status === 'canceled')) {
        await parkLateRenewal(storedSub, payment);
        return;
      }
      const storedPlan = storedSub ? await repo.plans.get(storedSub.planId) : null;
      const paymentRaw = record(payment.raw);
      const trialOpeningInvoice = ctx.provider.name === 'stripe'
        && payment.provider === 'stripe'
        && payment.kind === 'subscription'
        && payment.status === 'succeeded'
        && payment.amount.amountMinor === 0
        && paymentRaw?.['billing_reason'] === 'subscription_create'
        && storedSub?.status === 'trialing'
        && storedPlan !== null
        && storedPlan.trialDays > 0;
      if (trialOpeningInvoice) {
        await repo.payments.put({
          ...payment,
          raw: { ...(paymentRaw ?? {}), boilpaymentTrialOpeningInvoice: true },
        });
        return;
      }
      // DC-07 — a paid-zero invoice that is not a trial (a 100% forever/repeating discount) grants nothing.
      const inTrial = storedSub?.status === 'trialing' && storedPlan !== null && storedPlan.trialDays > 0;
      if (payment.amount.amountMinor === 0 && !inTrial) {
        await openZeroSaleCase({ repo, clock, policy, payment, notifier });
        return;
      }
      if (lifecycle) {
        // EC:K1 call-site audit — resolveLocalSubscription reads the row, then lifecycle.onRenewalPaid
        // does real work (rollover, grantForPeriod, ledger appends) before its own
        // repo.subscriptions.put; a concurrent writer (another webhook delivery, a scheduler tick,
        // a manual cancel) can win that race. Re-resolve the subscription on every retry attempt.
        // onRenewalPaid's own EC:A7 idempotency check (periodKey already granted -> duplicated:true,
        // no re-grant) makes replaying the whole call safe.
        await retryOnVersionConflict(async () => {
          const sub = await resolveLocalSubscription(ctx, ctx.event.subscriptionRef!);
          await lifecycle.onRenewalPaid({ sub, payment, policy, ledger: scopedLedger, repo, clock });
        });
        const [affiliateSub] = await repo.subscriptions.list({ provider: ctx.provider.name, providerRef: ctx.event.subscriptionRef } as Partial<Subscription>);
        if ((input.affiliateRenewals ?? 'first_only') === 'include') {
          await commerce.accrueAffiliate(payment, affiliateSub?.affiliateId ?? payment.affiliateId ?? null);
        } else if ((await repo.operations.get(`purchase-entitlement:${payment.id}`))?.kind === 'purchase.entitlement' && payment.affiliateId) {
          await commerce.accrueAffiliate(payment, payment.affiliateId);
        }
      }
    } else if (payment.kind === 'subscription' && payment.subscriptionId) {
      // EC:A45 — a self-scheduled renewal's own payment (PortOne sends Transaction.Paid for the charge
      // our scheduler made; the event names no subscription). It completes that renewal, never a top-up.
      if (payment.status !== 'succeeded') {
        throw new PaymentKitError('Renewal payment has not succeeded', 'renewal_payment_not_succeeded', { paymentId: payment.id, status: payment.status });
      }
      const stored = await repo.payments.get(payment.id);
      // EC:A50 (A6-6) — a held attempt waits for a person here too, and a pending one is only completed
      // when the provider's payment is the charge sent under its key (the same rule as the lookup).
      if (stored && isUnderReview(stored)) return;
      // EC:A58 — a person voided or closed this attempt: a late or redelivered webhook never grants it.
      if (stored && isClosedByPerson(stored)) return;
      if (stored && stored.status === 'pending') {
        const reason = lookupMismatch(payment, { amount: expectedAttemptAmount(stored), customerId: stored.customerId, currency: stored.amount.currency });
        if (reason) { await holdAttemptForReview(repo, notifier, stored, payment, reason); return; }
        await repo.payments.put({ ...stored, status: 'succeeded', providerRef: payment.providerRef, amount: payment.amount, failure: null });
      }
      // EC:A51 (A5-4) — the renewal this pays for is the stored attempt's period. The provider's copy has
      // none (PortOne) or could name another; falling back to the subscription's current period would
      // grant a period that already ended (a trial conversion paid twice). No stored period: the row is
      // recorded succeeded and the scheduler's attempt path completes the renewal.
      const paidPeriod = stored?.period ?? null;
      if (lifecycle && paidPeriod) {
        await retryOnVersionConflict(async () => {
          const sub = await repo.subscriptions.get(payment.subscriptionId as string);
          if (!sub) return markUnknownProviderRef('subscription', payment.subscriptionId as string, ctx.provider.name);
          await lifecycle.onRenewalPaid({ sub, payment: { ...payment, period: paidPeriod }, policy, ledger: scopedLedger, repo, clock });
        });
        const sub = await repo.subscriptions.get(payment.subscriptionId);
        if ((input.affiliateRenewals ?? 'first_only') === 'include') {
          await commerce.accrueAffiliate(payment, sub?.affiliateId ?? payment.affiliateId ?? null);
        } else if (payment.affiliateId) {
          await commerce.accrueAffiliate(payment, payment.affiliateId);
        }
      }
    } else if (credits) {
      // EC:E19 — only money that arrived buys credits: the status re-fetched from the provider must be
      // 'succeeded' (a forged or early notification, a pending virtual account, or a payment refunded
      // before this retry is refused; the record fails and a later delivery/retry re-checks).
      if (payment.status !== 'succeeded') {
        throw new PaymentKitError('Top-up payment has not succeeded', 'topup_payment_not_succeeded', { paymentId: payment.id, status: payment.status });
      }
      if (payment.amount.amountMinor === 0) { // DC-07
        await openZeroSaleCase({ repo, clock, policy, payment, notifier });
        return;
      }
      // EC:B10 — the kit cannot know how many credits a one-time payment buys; the app resolves it.
      const n = input.resolveTopupCredits ? await input.resolveTopupCredits(payment) : null;
      if (n === null || n === undefined) throw new Error('topup_credits_unresolved');
      await credits.topup({ customerId: payment.customerId, payment, credits: n, policy, ledger: scopedLedger, clock, repo });
      await commerce.accrueAffiliate(payment, payment.affiliateId ?? null);
    }
    await maybeIssueCashReceipt(payment, ctx.provider); // EC:K2 — after the goods are granted; applies to both subscription renewals and top-ups
  };

  const onSubscriptionPaymentFailed: Handler = async (ctx) => {
    if (!ctx.event.subscriptionRef) return;
    if (!lifecycle) return;
    // EC:K1 call-site audit — same reasoning as onPaymentSucceeded above.
    const scopedLedger = withCorrelationId(ledger, ctx.correlationId);
    await retryOnVersionConflict(async () => {
      // SB-07 — the provider may already expose the new unpaid period; dunning extends the stored
      // previous paid-period grant, while the provider read still verifies status/identity.
      const sub = await resolveLocalSubscription(ctx, ctx.event.subscriptionRef!, true);
      // SB-07 — dunning needs the scoped ledger to extend the prior period's grant expiry to grace.
      await lifecycle.dunning.onPaymentFailed({ sub, policy, ledger: scopedLedger, repo, notifier, clock });
    });
  };

  const onSubscriptionCreated: Handler = async (ctx) => {
    if (ctx.provider.name !== 'stripe' || !ctx.event.subscriptionRef) return;
    const checkoutId = stripeCheckoutSessionId(ctx.event.raw);
    if (!checkoutId) return;
    const operation = await repo.operations.get(`checkout-entitlement-by-id:${checkoutId}`);
    const snapshot = operation?.kind === 'checkout.entitlement' && operation.status === 'done'
      ? checkoutSubscriptionIdentity(operation.result)
      : null;
    // SB-03 — only a locally captured checkout snapshot may establish provider identity. A direct
    // dashboard subscription.created event remains a no-op rather than inventing customer/plan IDs.
    if (!snapshot || snapshot.provider !== ctx.provider.name) return;
    const subscriptionId = `subscription:${snapshot.provider}:${ctx.event.subscriptionRef}`;
    if (await repo.subscriptions.get(subscriptionId)) return;
    const remote = await ctx.provider.getSubscription(ctx.event.subscriptionRef);
    await repo.subscriptions.put({
      ...remote,
      id: subscriptionId,
      customerId: snapshot.customerId,
      planId: snapshot.planId,
      provider: snapshot.provider,
      providerRef: ctx.event.subscriptionRef,
      currency: snapshot.currency,
    });
  };

  const onSubscriptionCanceled: Handler = async (ctx) => {
    if (!ctx.event.subscriptionRef) return;
    const subs = await repo.subscriptions.list({ providerRef: ctx.event.subscriptionRef } as Partial<Subscription>);
    for (const sub of subs) {
      // EC:K1 call-site audit — re-read immediately before the write so a retry (after a conflict
      // with another writer touching this row between list() and put()) sees the latest version.
      await retryOnVersionConflict(async () => {
        const fresh = (await repo.subscriptions.get(sub.id)) ?? sub;
        await repo.subscriptions.put({ ...fresh, status: 'canceled' });
      });
    }
  };

  // EC:A27 — keep the local subscription in step with the provider for the non-entitled states:
  // entering paused / incomplete, and leaving them (resume, first payment landed). Other transitions
  // belong to dunning, renewal and cancel, so they are left alone here. Unknown subscription: no-op.
  const onSubscriptionUpdated: Handler = async (ctx) => {
    if (!ctx.event.subscriptionRef || !ctx.provider.capabilities().nativeSubscriptions) return;
    const [local] = await repo.subscriptions.list({ providerRef: ctx.event.subscriptionRef } as Partial<Subscription>);
    if (!local) return;
    const remote = await ctx.provider.getSubscription(ctx.event.subscriptionRef); // EC:E3 re-fetch
    const entering = INACTIVE_SUBSCRIPTION_STATUSES.includes(remote.status) && remote.status !== local.status;
    const leaving = INACTIVE_SUBSCRIPTION_STATUSES.includes(local.status) && (remote.status === 'active' || remote.status === 'trialing');
    if (!entering && !leaving) return;
    await retryOnVersionConflict(async () => {
      const fresh = (await repo.subscriptions.get(local.id)) ?? local;
      await repo.subscriptions.put({ ...fresh, status: remote.status, currentPeriod: remote.currentPeriod, cancelAtPeriodEnd: remote.cancelAtPeriodEnd });
    });
  };

  const onRefundCreated: Handler = async (ctx) => {
    // EC:L5 — see onPaymentSucceeded above.
    if (!refund) return;
    const event = await localizePaymentEvent(ctx, await authoritativeRefundEvent(ctx, notifier), 'refund', repo, clock, notifier);
    await refund.onExternalRefund({ event, ledger: withCorrelationId(ledger, ctx.correlationId), repo, cs }); // EC:D8
  };

  const onDispute: Handler = async (ctx) => {
    // EC:L5 — see onPaymentSucceeded above.
    if (!cs) return;
    const event = await localizePaymentEvent(ctx, ctx.event, 'dispute', repo, clock, notifier);
    await cs.dispute({ event, policy, ledger: withCorrelationId(ledger, ctx.correlationId), repo, notifier, provider: ctx.provider }); // EC:B11 D9 A66
  };

  const onUnknown: Handler = async () => { /* ignored, no-op */ };

  return {
    'payment.succeeded': onPaymentSucceeded,
    'subscription.created': onSubscriptionCreated,
    'subscription.payment_failed': onSubscriptionPaymentFailed,
    'subscription.canceled': onSubscriptionCanceled,
    'subscription.updated': onSubscriptionUpdated,
    'refund.created': onRefundCreated,
    'refund.failed': onRefundCreated,
    'refund.pending': onRefundCreated,
    'dispute.opened': onDispute,
    'dispute.closed': onDispute,
    unknown: onUnknown,
  };
}
