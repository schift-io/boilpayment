// spec: packages/lifecycle/spec/lifecycle.pseudo.md — EC:F (Toss/Portone self-scheduling)
import { Clock, IdGen, NoopNotifier, Notifier, PaymentKitError, PaymentProvider, Policy, Repo, LedgerStore, Subscription } from '@schift/payment-kit-core';
import { onRenewalPaid } from './renewal.js';
import { onPaymentFailed } from './dunning.js';
import { nextPeriod } from './period.js';
import { retryOnVersionConflict } from './retry.js';
import { scopeProvider } from './internal.js';

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

export interface SchedulerTickResult {
  charged: Subscription[];
  failed: Subscription[];
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
    return { charged: [], failed: [] };
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

  for (const dueSub of due) {
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
      const plan = await repo.plans.get(sub.planId);
      if (!plan || plan.prices.length === 0) {
        return { kind: 'failed' as const, sub };
      }
      const price = plan.prices[0];
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
          const interval = plan.interval ?? 'month';
          const chargedPeriod = nextPeriod(sub.currentPeriod, interval, sub.anchorDay, policy.period.timezone, policy.period.monthEndAnchor);
          const result = await onRenewalPaid({ sub, payment: { ...payment, period: chargedPeriod }, policy, ledger, repo, clock });
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
    if (!outcome) continue;
    if (outcome.kind === 'charged') charged.push(outcome.sub);
    else failed.push(outcome.sub);
  }

  return { charged, failed };
}
