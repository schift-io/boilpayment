// spec: packages/lifecycle/spec/lifecycle.pseudo.md — EC:F (Toss/Portone self-scheduling)
import { Clock, IdGen, NoopNotifier, Notifier, PaymentKitError, PaymentProvider, Policy, Repo, LedgerStore, Subscription } from 'boilpayment-core';
import { onRenewalPaid } from './renewal.js';
import { onPaymentFailed } from './dunning.js';
import { nextPeriod } from './period.js';
import { retryOnVersionConflict } from './retry.js';
import { priceForSubscription, renewalPlanId } from './internal.js';
import { attemptKeyOf, attemptsFor, chargeAttempt, isLegacyAttempt, isUnderReview, markUnresolved, renewalAttemptKey } from './charge-attempt.js';
import { checkLegacyDunning, settleLegacyEnded, settleOrphanAttempts } from './legacy-attempts.js';
import { applyMissedPeriods, settleOpenAttemptIfBehind } from './missed-periods.js';

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
  // EC:A34 A36 — past_due rows too: an attempt of theirs whose outcome is unknown is re-driven here.
  return all.filter((s) => (s.status === 'active' || s.status === 'past_due') && !s.cancelAtPeriodEnd && s.billingKey !== null && s.currentPeriod.end <= now);
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
  // EC:A40 — a past_due subscription canceled at period end ends too: its period already ended, so
  // dunning stops and nothing more is charged.
  const cancellations = (await repo.subscriptions.list()).filter((sub) =>
    sub.provider === provider.name && (sub.status === 'active' || sub.status === 'past_due') && sub.cancelAtPeriodEnd &&
    sub.currentPeriod.end <= clock.now());
  for (const pendingCancel of cancellations) {
    await retryOnVersionConflict(async () => {
      const sub = await repo.subscriptions.get(pendingCancel.id);
      if (!sub || sub.provider !== provider.name || (sub.status !== 'active' && sub.status !== 'past_due') ||
          !sub.cancelAtPeriodEnd || sub.currentPeriod.end > clock.now()) return;
      await repo.subscriptions.put({ ...sub, status: 'canceled', cancelAtPeriodEnd: false, graceUntil: null });
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

  // EC:A38 — attempts left pending by subscriptions that ended meanwhile are settled by lookup.
  const orphans = await settleOrphanAttempts({ provider, repo, ledger, policy, clock, notifier });
  // EC:A39 (A5-3) — an ended subscription whose earlier-release dunning charge may have moved money.
  try {
    await settleLegacyEnded({ provider, repo, ledger, policy, clock, notifier });
  } catch (err) {
    errors.push({ subscriptionId: '*', code: 'legacy_settlement_error', message: err instanceof Error ? err.message : String(err) });
  }
  for (const u of orphans.unresolved) {
    errors.push({ subscriptionId: u.subscriptionId, code: 'renewal_charge_unresolved', message: `attempt ${u.paymentId} still has no answer from the provider` });
  }

  return { charged, failed, errors };
}

async function renewOne(input: SchedulerTickInput, dueSub: Subscription, notifier: Notifier) {
  const { provider, repo, policy, ledger, clock } = input;
  const correlationId = `corr_sched_${dueSub.id}_${dueSub.currentPeriod.end.toISOString()}`;
  const outcome = await retryOnVersionConflict(async () => {
    const sub = await repo.subscriptions.get(dueSub.id);
    // Never charge a newer period, or a subscription canceled/removed by another writer meanwhile.
    if (!sub || (sub.status !== 'active' && sub.status !== 'past_due') || sub.cancelAtPeriodEnd ||
        sub.provider !== provider.name || !sub.billingKey ||
        sub.currentPeriod.end > clock.now() ||
        sub.currentPeriod.end.getTime() !== dueSub.currentPeriod.end.getTime()) {
      return null;
    }
    // EC:A29 — charge the plan the subscription renews INTO; EC:A28 — in the subscription's currency.
    const plan = await repo.plans.get(renewalPlanId(sub));
    const price = plan ? priceForSubscription(plan, sub) : null;
    if (!plan || !price) {
      if (sub.status !== 'active') return null; // already in dunning; its retries tell a person
      // EC:A31 — a missing plan or price is a configuration fault: no charge, dunning, a person is told.
      await notifier.send({ type: 'cs.needs_human', customerId: sub.customerId, payload: {
        kind: 'plan_price_missing', subscriptionId: sub.id, planId: renewalPlanId(sub), currency: sub.currency ?? null } });
      const result = await onPaymentFailed({ sub, policy, repo, notifier, clock });
      return { kind: 'failed' as const, sub: result.sub };
    }
    let chargedPeriod = nextPeriod(sub.currentPeriod, plan.interval ?? 'month', sub.anchorDay, policy.period.timezone, policy.period.monthEndAnchor);

    // EC:A34 — one (subscription, period) is charged at most once. A succeeded attempt (the
    // scheduler's or a dunning retry's) finishes the renewal; an attempt whose outcome is unknown is
    // re-driven with its own key; a new charge is started only for an active subscription.
    let attempts = await attemptsFor(repo, sub, chargedPeriod);
    const paid = attempts.find((p) => p.status === 'succeeded');
    if (paid) {
      const result = await onRenewalPaid({ sub, payment: paid, policy, ledger, repo, clock });
      return { kind: 'charged' as const, sub: result.sub };
    }
    const legacyOpen = attempts.some((p) => p.status !== 'failed' && isLegacyAttempt(p));
    let open = attempts.find((p) => p.status !== 'failed' && !isLegacyAttempt(p));
    if (open && !isUnderReview(open)) {
      // EC:A47 (A6-4) — an open attempt for a period that already ended, more periods behind: ask first.
      const now = await settleOpenAttemptIfBehind({ provider, repo, clock, notifier, sub, plan, policy, open });
      if (now.status === 'succeeded') {
        const result = await onRenewalPaid({ sub, payment: now, policy, ledger, repo, clock });
        return { kind: 'charged' as const, sub: result.sub };
      }
      if (now.status === 'failed') open = undefined;
    }
    if (!open && !legacyOpen && sub.status !== 'active') return null; // every attempt answered: dunning owns the next charge
    if (!open) {
      // EC:A39 — a dunning charge of an earlier release (no row) may already have paid this period.
      const legacy = await checkLegacyDunning({ provider, repo, clock, sub, period: chargedPeriod, price, notifier });
      if (legacy.kind === 'paid') {
        const result = await onRenewalPaid({ sub, payment: legacy.payment, policy, ledger, repo, clock });
        return { kind: 'charged' as const, sub: result.sub };
      }
      if (legacy.kind === 'unverified') {
        throw new PaymentKitError('An earlier release may already have charged this period; not charging until the provider confirms', 'legacy_dunning_unverified', {
          subscriptionId: sub.id, orderIds: legacy.orderIds });
      }
    }
    let renewing = sub;
    if (!open) {
      // EC:A47 (A5-1) — more than one period behind: never bill the missed periods one tick at a time.
      const missed = await applyMissedPeriods({ sub, plan, policy, repo, notifier, clock });
      if (missed.kind === 'parked') return { kind: 'failed' as const, sub: missed.sub };
      if (missed.kind === 'skipped') {
        renewing = missed.sub;
        chargedPeriod = missed.target;
        attempts = await attemptsFor(repo, renewing, chargedPeriod);
        const paidTarget = attempts.find((p) => p.status === 'succeeded');
        if (paidTarget) {
          const result = await onRenewalPaid({ sub: renewing, payment: paidTarget, policy, ledger, repo, clock });
          return { kind: 'charged' as const, sub: result.sub };
        }
        open = attempts.find((p) => p.status !== 'failed' && !isLegacyAttempt(p));
      }
    }
    const attemptKey = (open && attemptKeyOf(open)) || renewalAttemptKey(renewing, chargedPeriod);
    const charge = await chargeAttempt({ provider, repo, clock, sub: renewing, price, period: chargedPeriod, attemptKey, correlationId, notifier });
    switch (charge.kind) {
      case 'in_flight':
        return null; // EC:A37 — another worker is charging this attempt right now
      case 'succeeded': {
        const result = await onRenewalPaid({ sub: renewing, payment: charge.payment, policy, ledger, repo, clock });
        return { kind: 'charged' as const, sub: result.sub };
      }
      case 'declined': {
        if (renewing.status !== 'active') {
          // EC:A36 A41 — the scheduler's own attempt, unresolved until now, turned out declined: dunning
          // takes over (grace restarts from today, smart retries are scheduled), exactly once.
          if (!charge.fresh || attemptKeyOf(charge.payment) !== renewalAttemptKey(renewing, chargedPeriod)) return { kind: 'failed' as const, sub: renewing };
          const result = await onPaymentFailed({ sub: renewing, policy, repo, notifier, clock });
          return { kind: 'failed' as const, sub: result.sub };
        }
        const result = await onPaymentFailed({ sub: renewing, policy, repo, notifier, clock });
        return { kind: 'failed' as const, sub: result.sub };
      }
      case 'unresolved': {
        // EC:A36 — past the period end with no answer: grace instead of indefinite access, one notice,
        // and the error is reported every tick until the provider answers.
        await markUnresolved({ sub: renewing, repo, notifier, clock, graceDays: policy.dunning.graceDays, payment: charge.payment, reason: charge.reason });
        throw new PaymentKitError(`Renewal charge requires reconciliation: ${charge.reason}`, 'scheduler_charge_unresolved', {
          subscriptionId: renewing.id, paymentId: charge.payment.id, status: charge.payment.status, attemptKey, reason: charge.reason,
        });
      }
    }
  });
  return outcome;
}
