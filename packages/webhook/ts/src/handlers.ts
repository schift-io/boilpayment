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
} from 'boilpayment-core';
import type {
  CashReceiptType, Clock, IdGen, LedgerStore, Notifier, Payment, PaymentProvider, Policy, Repo, Subscription,
} from 'boilpayment-core';
import type { Handler, HandlerCtx, HandlerMap } from './process.js';
import { withCorrelationId } from './correlation.js';

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

export interface LifecycleDeps {
  onRenewalPaid(input: { sub: Subscription; payment: Payment; policy: Policy; ledger: LedgerStore; repo: Repo; clock: Clock }): Promise<unknown>;
  dunning: {
    onPaymentFailed(input: { sub: Subscription; policy: Policy; repo: Repo; notifier: Notifier; clock: Clock }): Promise<unknown>;
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
  dispute(input: { event: HandlerCtx['event']; policy: Policy; ledger: LedgerStore; repo: Repo; notifier: Notifier }): Promise<unknown>;
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
}

export function defaultHandlers(input: DefaultHandlersInput): HandlerMap {
  const { policy, ledger, repo, notifier, clock, ids, lifecycle, credits, refund, cs } = input;

  // Not-found local entity for a webhook's providerRef -> notify + fail the record (caught by process()).
  async function markUnknownProviderRef(kind: 'subscription' | 'payment', providerRef: string, providerName: string): Promise<never> {
    await notifier.send({ type: 'reconcile.mismatch', customerId: null, payload: { kind, providerRef, provider: providerName } });
    throw new Error('unknown_provider_ref');
  }

  async function resolveLocalSubscription(ctx: HandlerCtx, providerRef: string): Promise<Subscription> {
    const subs = await repo.subscriptions.list({ providerRef } as Partial<Subscription>);
    if (subs.length === 0) return markUnknownProviderRef('subscription', providerRef, ctx.provider.name);
    let sub = subs[0];
    // EC:F — Toss/PortOne have no native provider-side subscription (self-scheduled by us);
    // getSubscription() throws PaymentKitError('unsupported') there, so only re-fetch when supported.
    if (ctx.provider.capabilities().nativeSubscriptions) {
      const providerSub = await ctx.provider.getSubscription(providerRef); // re-fetch for verification (EC:E3)
      sub = { ...sub, status: providerSub.status, currentPeriod: providerSub.currentPeriod, cancelAtPeriodEnd: providerSub.cancelAtPeriodEnd, graceUntil: providerSub.graceUntil };
    }
    return sub;
  }

  async function resolveLocalPayment(ctx: HandlerCtx, providerRef: string): Promise<Payment> {
    const payments = await repo.payments.list({ providerRef } as Partial<Payment>);
    if (payments.length === 0) return markUnknownProviderRef('payment', providerRef, ctx.provider.name);
    const providerPayment = await ctx.provider.getPayment(providerRef); // re-fetch for verification (EC:E3)
    return { ...payments[0], status: providerPayment.status, amount: providerPayment.amount, period: providerPayment.period, occurredAt: providerPayment.occurredAt, failure: providerPayment.failure };
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
    return repo.payments.put({
      id: ids.newId(), customerId: sub.customerId, provider: ctx.provider.name, providerRef: paymentRef, subscriptionId: sub.id,
      amount: remote.amount, status: remote.status, kind: 'subscription', period: remote.period, occurredAt: remote.occurredAt,
      failure: remote.failure, cashReceipt: null,
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

  const onPaymentSucceeded: Handler = async (ctx) => {
    // EC:L5 — every ledger append lifecycle/credits make while handling THIS delivery gets
    // ctx.correlationId merged into its reference, without lifecycle/credits knowing correlationId
    // exists (see correlation.ts doc comment).
    const scopedLedger = withCorrelationId(ledger, ctx.correlationId);
    const payment = ctx.event.subscriptionRef
      ? await resolveRenewalPayment(ctx, ctx.event.paymentRef!, ctx.event.subscriptionRef)
      : await resolveLocalPayment(ctx, ctx.event.paymentRef!);
    if (ctx.event.subscriptionRef) {
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
      }
    } else if (payment.kind === 'subscription' && payment.subscriptionId) {
      // EC:A45 — a self-scheduled renewal's own payment (PortOne sends Transaction.Paid for the charge
      // our scheduler made; the event names no subscription). It completes that renewal, never a top-up.
      if (payment.status !== 'succeeded') {
        throw new PaymentKitError('Renewal payment has not succeeded', 'renewal_payment_not_succeeded', { paymentId: payment.id, status: payment.status });
      }
      const stored = await repo.payments.get(payment.id);
      if (stored && stored.status === 'pending') await repo.payments.put({ ...stored, status: 'succeeded', providerRef: payment.providerRef, amount: payment.amount, failure: null });
      if (lifecycle) {
        await retryOnVersionConflict(async () => {
          const sub = await repo.subscriptions.get(payment.subscriptionId as string);
          if (!sub) return markUnknownProviderRef('subscription', payment.subscriptionId as string, ctx.provider.name);
          await lifecycle.onRenewalPaid({ sub, payment, policy, ledger: scopedLedger, repo, clock });
        });
      }
    } else if (credits) {
      // EC:E19 — only money that arrived buys credits: the status re-fetched from the provider must be
      // 'succeeded' (a forged or early notification, a pending virtual account, or a payment refunded
      // before this retry is refused; the record fails and a later delivery/retry re-checks).
      if (payment.status !== 'succeeded') {
        throw new PaymentKitError('Top-up payment has not succeeded', 'topup_payment_not_succeeded', { paymentId: payment.id, status: payment.status });
      }
      // EC:B10 — the kit cannot know how many credits a one-time payment buys; the app resolves it.
      const n = input.resolveTopupCredits ? await input.resolveTopupCredits(payment) : null;
      if (n === null || n === undefined) throw new Error('topup_credits_unresolved');
      await credits.topup({ customerId: payment.customerId, payment, credits: n, policy, ledger: scopedLedger, clock, repo });
    }
    await maybeIssueCashReceipt(payment, ctx.provider); // EC:K2 — after the goods are granted; applies to both subscription renewals and top-ups
  };

  const onSubscriptionPaymentFailed: Handler = async (ctx) => {
    if (!ctx.event.subscriptionRef) return;
    if (!lifecycle) return;
    // EC:K1 call-site audit — same reasoning as onPaymentSucceeded above.
    await retryOnVersionConflict(async () => {
      const sub = await resolveLocalSubscription(ctx, ctx.event.subscriptionRef!);
      await lifecycle.dunning.onPaymentFailed({ sub, policy, repo, notifier, clock });
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
    if (refund) await refund.onExternalRefund({ event: await authoritativeRefundEvent(ctx, notifier), ledger: withCorrelationId(ledger, ctx.correlationId), repo, cs }); // EC:D8
  };

  const onDispute: Handler = async (ctx) => {
    // EC:L5 — see onPaymentSucceeded above.
    if (cs) await cs.dispute({ event: ctx.event, policy, ledger: withCorrelationId(ledger, ctx.correlationId), repo, notifier }); // EC:B11 D9
  };

  const onUnknown: Handler = async () => { /* ignored, no-op */ };

  return {
    'payment.succeeded': onPaymentSucceeded,
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
