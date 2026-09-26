// spec: packages/lifecycle/spec/lifecycle.pseudo.md — EC:F (Toss/Portone self-scheduling)
import { Clock, IdGen, NoopNotifier, Notifier, PaymentKitError, PaymentProvider, Policy, Repo, LedgerStore, Subscription } from 'boilpayment-core';
import type { Payment, Period } from 'boilpayment-core';
import { onRenewalPaid } from './renewal.js';
import { onPaymentFailed } from './dunning.js';
import { nextPeriod } from './period.js';
import { retryOnVersionConflict } from './retry.js';
import { priceForSubscription, renewalPlanId, scopeProvider } from './internal.js';

export interface DueSubscriptionsInput {
  repo: Repo;
  clock: Clock;
}

// EC:F — subscriptions whose current period has elapsed and which carry a billing key
// (self-scheduling providers: Toss/Portone have no native subscription/scheduler).
export async function dueSubscriptions(input: DueSubscriptionsInput): Promise<Subscription[]> {
  const { repo, clock } = input;
  const now = clock.now();
  const all = await repo.subscriptions.list();
  return all.filter((s) => s.status === 'active' && !s.cancelAtPeriodEnd && s.billingKey !== null && s.currentPeriod.end <= now);
}

export interface SchedulerTickInput {
  provider: PaymentProvider;
  repo: Repo;
  policy: Policy;
  ledger: LedgerStore;
  clock: Clock;
  ids: IdGen;
  notifier?: Notifier; // not in the ARCHITECTURE.md signature; defaults to a no-op notifier
}

export interface SchedulerTickError {
  subscriptionId: string;
  code: string;
  message: string;
}

export interface SchedulerTickResult {
  charged: Subscription[];
  failed: Subscription[];
  /** EC:A30 — one subscription's failure never stops the others; each is reported here. */
  errors: SchedulerTickError[];
}

// EC:F — charge every due self-scheduled subscription and drive the renewal/dunning outcome.
// Only runs for providers whose capabilities().scheduling === 'self' (Toss). Providers with
// scheduling === 'provider' (PortOne's own schedule API, Stripe/Polar's native billing) manage
// their own renewal timing and notify us via the payment.succeeded webhook -> onRenewalPaid
// instead; calling tick() for one of those is a deliberate no-op, not an error.
export async function tick(input: SchedulerTickInput): Promise<SchedulerTickResult> {
  const { provider, repo, policy, ledger, clock } = input;
  const notifier = input.notifier ?? new NoopNotifier();

  if (provider.capabilities().scheduling !== 'self') {
    return { charged: [], failed: [], errors: [] };
  }

  // Self-scheduled providers emit no termination webhook for a locally scheduled cancel.
  // Finish elapsed cancellations before selecting renewals, including rows without billing keys.
  const cancellations = (await repo.subscriptions.list()).filter((sub) =>
    sub.provider === provider.name && sub.status === 'active' && sub.cancelAtPeriodEnd &&
    sub.currentPeriod.end <= clock.now());
  for (const pendingCancel of cancellations) {
    await retryOnVersionConflict(async () => {
      const sub = await repo.subscriptions.get(pendingCancel.id);
      if (!sub || sub.provider !== provider.name || sub.status !== 'active' ||
          !sub.cancelAtPeriodEnd || sub.currentPeriod.end > clock.now()) return;
      await repo.subscriptions.put({ ...sub, status: 'canceled', cancelAtPeriodEnd: false });
    });
  }

  const due = await dueSubscriptions({ repo, clock });
  const charged: Subscription[] = [];
  const failed: Subscription[] = [];
  const errors: SchedulerTickError[] = [];

  for (const dueSub of due) {
    // EC:A30 — isolate each subscription: an unresolved charge or a local failure is reported and
    // the loop moves on, so one row can never stall every renewal after it.
    try {
      const outcome = await renewOne(input, dueSub, notifier);
      if (!outcome) continue;
      if (outcome.kind === 'charged') charged.push(outcome.sub);
      else failed.push(outcome.sub);
    } catch (err) {
      errors.push({
        subscriptionId: dueSub.id,
        code: err instanceof PaymentKitError ? err.code : 'scheduler_error',
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return { charged, failed, errors };
}

async function renewOne(input: SchedulerTickInput, dueSub: Subscription, notifier: Notifier) {
  const { provider, repo, policy, ledger, clock } = input;
  // Reuse the original period key after a version conflict; never charge a newer period
  // or a subscription canceled/removed by another writer while this tick was running.
  const idempotencyKey = `charge:${dueSub.id}:${dueSub.currentPeriod.end.toISOString()}`;
  const correlationId = `corr_sched_${dueSub.id}_${dueSub.currentPeriod.end.toISOString()}`;
  const outcome = await retryOnVersionConflict(async () => {
    const sub = await repo.subscriptions.get(dueSub.id);
    if (!sub || sub.status !== 'active' || sub.cancelAtPeriodEnd ||
        sub.provider !== provider.name || !sub.billingKey ||
        sub.currentPeriod.end > clock.now() ||
        sub.currentPeriod.end.getTime() !== dueSub.currentPeriod.end.getTime()) {
      return null;
    }
    // EC:A29 — charge the plan the subscription renews INTO (a scheduled downgrade/change applies at
    // this renewal), the same plan onRenewalPaid grants.
    const plan = await repo.plans.get(renewalPlanId(sub));
    // EC:A28 — the price in the subscription's currency; none means no charge (never another currency).
    const price = plan ? priceForSubscription(plan, sub) : null;
    if (!plan || !price) {
      // EC:A31 — a missing plan or price is a configuration fault: no charge, the subscription goes
      // through dunning (past_due, grace) and a person is told, instead of staying active unpaid.
      await notifier.send({ type: 'cs.needs_human', customerId: sub.customerId, payload: {
        kind: 'plan_price_missing', subscriptionId: sub.id, planId: renewalPlanId(sub), currency: sub.currency ?? null } });
      const result = await onPaymentFailed({ sub, policy, repo, notifier, clock });
      return { kind: 'failed' as const, sub: result.sub };
    }
    const interval = plan.interval ?? 'month';
    const chargedPeriod = nextPeriod(sub.currentPeriod, interval, sub.anchorDay, policy.period.timezone, policy.period.monthEndAnchor);
    // EC:A30 — a charge that already succeeded for this period (its local steps failed on an
    // earlier tick) is resumed from the stored payment, never charged again.
    const paid = (await repo.payments.list({ subscriptionId: sub.id } as Partial<Payment>)).find((p) =>
      p.kind === 'subscription' && p.status === 'succeeded' && p.period?.start.getTime() === chargedPeriod.start.getTime());
    if (paid) {
      const result = await onRenewalPaid({ sub, payment: paid, policy, ledger, repo, clock });
      return { kind: 'charged' as const, sub: result.sub };
    }
    // Transport exceptions do not prove a declined charge. Propagate for reconciliation;
    // local renewal/ledger failures must likewise never trigger another payment or dunning.
    const payment = await scopeProvider(provider, correlationId).chargeBillingKey({
      billingKey: sub.billingKey,
      amount: { amountMinor: price.amountMinor, currency: price.currency },
      orderId: idempotencyKey,
      customerRef: sub.customerId,
      idempotencyKey,
    });
    switch (payment.status) {
      case 'succeeded': {
        const stored = await recordRenewalPayment({ repo, ids: input.ids, sub, payment, period: chargedPeriod });
        const result = await onRenewalPaid({ sub, payment: stored, policy, ledger, repo, clock });
        return { kind: 'charged' as const, sub: result.sub };
      }
      case 'failed': {
        const result = await onPaymentFailed({ sub, policy, repo, notifier, clock });
        return { kind: 'failed' as const, sub: result.sub };
      }
      case 'pending':
      case 'requires_action':
      case 'refunded':
      case 'partially_refunded':
      case 'disputed':
        throw new PaymentKitError('Renewal charge requires reconciliation', 'scheduler_charge_unresolved', {
          subscriptionId: sub.id, paymentId: payment.id, status: payment.status, idempotencyKey,
        });
      default: {
        const unreachable: never = payment.status;
        throw new PaymentKitError('Unknown payment status', 'scheduler_charge_unresolved', unreachable);
      }
    }
  });
  return outcome;
}


/**
 * EC:A26 — a self-scheduled renewal has no webhook to create its payment row (Toss sends none for
 * billing payments), so store it here: refunds, settlement, timeline and missing-grant recovery all
 * start from local payments. A retried charge returns the same provider payment (same idempotency
 * key), so an existing (provider, providerRef) row is reused rather than duplicated.
 */
async function recordRenewalPayment(input: { repo: Repo; ids: IdGen; sub: Subscription; payment: Payment; period: Period }): Promise<Payment> {
  const { repo, ids, sub, payment, period } = input;
  const [existing] = await repo.payments.list({ provider: payment.provider, providerRef: payment.providerRef } as Partial<Payment>);
  const row: Payment = {
    ...payment,
    id: existing?.id ?? ids.newId(),
    customerId: sub.customerId,
    subscriptionId: sub.id,
    kind: 'subscription',
    period,
  };
  await repo.payments.put(row);
  return row;
}
