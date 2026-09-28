// spec: packages/lifecycle/spec/lifecycle.pseudo.md — EC:A7 A15 A17 A25 A32 B12
import { Clock, CsCase, LedgerStore, PaymentKitError, Payment, Plan, Policy, Repo, Subscription, civilDayOf, keyMatchesInstant } from 'boilpayment-core';
import { grantForPeriod, GrantResult, rolloverOnRenewal, RolloverResult } from 'boilpayment-credits';
import { applyChange, pendingUpgradeGrantKey } from './upgrade.js';
import type { UpgradeAnchorIntent } from './upgrade.js';

export interface OnRenewalPaidInput {
  sub: Subscription;
  payment: Payment;
  policy: Policy;
  ledger: LedgerStore;
  repo: Repo;
  clock: Clock;
}

export interface OnRenewalPaidResult {
  sub: Subscription;
  grant: GrantResult;
  rollover: RolloverResult;
  duplicated: boolean;
  recovered: boolean;
}

const NO_ROLLOVER: RolloverResult = { entries: [], banked: 0, expired: 0 };

function rawContains(value: unknown, expected: string): boolean {
  if (value === expected) return true;
  if (Array.isArray(value)) return value.some((item) => rawContains(item, expected));
  if (value !== null && typeof value === 'object') return Object.values(value).some((item) => rawContains(item, expected));
  return false;
}

async function openRenewalMismatchCase(input: {
  sub: Subscription; payment: Payment; policy: Policy; repo: Repo; clock: Clock; actualPlanId: string | null;
}): Promise<void> {
  const { sub, payment, policy, repo, clock, actualPlanId } = input;
  const id = `reconcile_mismatch:${payment.id}`;
  if (await repo.csCases.get(id)) return;
  const csCase: CsCase = {
    id, customerId: sub.customerId, kind: 'reconcile_mismatch', status: 'needs_human', referenceId: payment.id,
    policySnapshot: structuredClone(policy), decision: {
      subscriptionId: sub.id, expectedPlanId: sub.scheduledPlanId, actualPlanId,
      amountMinor: payment.amount.amountMinor, currency: payment.amount.currency,
    }, churnReason: null, churnText: null, openedAt: clock.now(), resolvedAt: null, escalatedAt: clock.now(),
  };
  await repo.csCases.put(csCase);
}

/** SB-14 — scheduled local plan state is accepted only when the renewal charge agrees with it. */
async function resolvePaidPlan(input: {
  sub: Subscription; payment: Payment; policy: Policy; repo: Repo; clock: Clock;
}): Promise<Plan> {
  const { sub, payment, policy, repo, clock } = input;
  const intendedId = sub.scheduledPlanId ?? sub.planId;
  const intended = await repo.plans.get(intendedId);
  if (!intended) throw new PaymentKitError(`plan not found: ${intendedId}`, 'plan_not_found');
  if (!sub.scheduledPlanId) return intended;
  const currency = payment.amount.currency.toUpperCase();
  const intendedRefMatches = intended.prices.some((price) => {
    const ref = price.providerPriceRefs?.[payment.provider];
    return ref !== undefined && rawContains(payment.raw, ref);
  });
  const intendedAmountMatches = intended.prices.some((price) =>
    price.currency.toUpperCase() === currency && price.amountMinor === payment.amount.amountMinor);
  if (intendedRefMatches || intendedAmountMatches) return intended;

  const plans = await repo.plans.list();
  const byProviderRef = plans.filter((plan) => plan.prices.some((price) => {
    const ref = price.providerPriceRefs?.[payment.provider];
    return ref !== undefined && rawContains(payment.raw, ref);
  }));
  const byAmount = plans.filter((plan) => plan.prices.some((price) =>
    price.currency.toUpperCase() === currency && price.amountMinor === payment.amount.amountMinor));
  const matches = byProviderRef.length > 0 ? byProviderRef : byAmount;
  const actual = matches.length === 1 ? matches[0] ?? null : null;
  await openRenewalMismatchCase({ sub, payment, policy, repo, clock, actualPlanId: actual?.id ?? null });
  if (!actual) {
    throw new PaymentKitError('renewal charge does not identify one plan; refusing to grant', 'renewal_plan_mismatch', {
      subscriptionId: sub.id, paymentId: payment.id, expectedPlanId: intended.id,
    });
  }
  return actual;
}

function matchesUpgradeAnchorIntent(intent: UpgradeAnchorIntent, payment: Payment): boolean {
  if (payment.provider !== 'stripe' || payment.status !== 'succeeded' || !payment.period) return false;
  const sourceStart = new Date(intent.sourcePeriodStart);
  const sourceEnd = new Date(intent.sourcePeriodEnd);
  return payment.period.start > sourceStart && payment.period.start < sourceEnd &&
    payment.occurredAt >= sourceStart && payment.occurredAt < sourceEnd;
}

/** SB-11 — settle a Stripe reset-anchor invoice before the ordinary full-plan renewal path. */
async function settleUpgradeAnchorInvoice(input: OnRenewalPaidInput): Promise<OnRenewalPaidResult | null> {
  const { sub, payment, policy, ledger, repo, clock } = input;
  if (!payment.period || payment.status !== 'succeeded' || payment.provider !== 'stripe') return null;
  const candidates = await repo.operations.list({ kind: 'lifecycle.upgrade_anchor', status: 'in_progress' });
  const op = candidates.find((candidate) => {
    const intent = candidate.result as UpgradeAnchorIntent;
    return intent.subId === sub.id && matchesUpgradeAnchorIntent(intent, payment);
  });
  if (!op) return null;
  const intent = op.result as UpgradeAnchorIntent;
  const period = payment.period;
  const grantKey = `grant:${sub.id}:${period.start.toISOString()}`;
  let grant = (await ledger.entries(sub.customerId, { kind: 'grant', source: 'subscription' }))
    .find((entry) => entry.idempotencyKey === grantKey) ?? null;
  let duplicated = grant !== null;
  if (!grant) {
    const appended = await ledger.append({
      customerId: sub.customerId, pool: 'paid', kind: 'grant', amount: intent.delta,
      unitPriceMinor: null, currency: null,
      expiresAt: policy.credits.rollover === 'full' ? null : period.end, source: 'subscription',
      reference: { subscriptionId: sub.id, periodStart: period.start, paymentId: payment.id },
      idempotencyKey: grantKey, actor: 'system', reason: `upgrade:${intent.fromPlanId}->${intent.toPlanId}`,
    });
    grant = appended.entry;
    duplicated = appended.duplicated;
  } else if (grant.reference.paymentId !== payment.id) {
    await ledger.append({
      customerId: sub.customerId, pool: grant.pool, kind: 'adjust', amount: 0,
      unitPriceMinor: null, currency: null, expiresAt: null, source: 'subscription',
      reference: { subscriptionId: sub.id, periodStart: period.start, grantId: grant.id, paymentId: payment.id },
      idempotencyKey: `adjust:upgrade-invoice:${grant.id}:${payment.id}`,
      actor: 'system', reason: 'SB-11 upgrade_invoice_attribution',
    });
  }
  const stored = (await repo.subscriptions.get(sub.id)) ?? sub;
  const alreadyApplied = stored.planId === intent.toPlanId &&
    stored.currentPeriod.start.getTime() === period.start.getTime() &&
    stored.currentPeriod.end.getTime() === period.end.getTime() && stored.status === 'active';
  const updated = alreadyApplied ? stored : await applyChange(repo, stored, (base) => ({
      ...base, planId: intent.toPlanId, scheduledPlanId: null, currentPeriod: period,
      anchorDay: civilDayOf(period.start, policy.period.timezone), status: 'active', graceUntil: null,
    }));
  await repo.operations.put({
    ...op, status: 'done', completedAt: clock.now(), result: {
      ...intent, paymentId: payment.id, grantId: grant.id,
      targetPeriodStart: period.start.toISOString(), targetPeriodEnd: period.end.toISOString(),
    },
  });
  return {
    sub: updated,
    grant: { entry: grant, duplicated, deferred: false, offset: 0, offsetEntries: [] },
    rollover: NO_ROLLOVER, duplicated, recovered: sub.status === 'past_due',
  };
}

// EC:A7 A15 A17 B12 — apply a successful renewal payment: grant the paid-for period's credits,
// roll over the previous period's leftover, advance the period, clear dunning state.
//
// Which period this payment is for is taken from `payment.period` when the caller (a webhook
// handler or, for self-scheduling providers, lifecycle.scheduler.tick — see period.ts/scheduler.ts)
// supplied it; that is the unambiguous source of truth (Stripe invoices, Toss/Portone schedules,
// etc. all know their own billing period). Falling back to `sub.currentPeriod` when it's absent
// makes EC:A7 (same-period reactivation) a no-advance no-op by construction, and avoids the
// bug of rolling over a grant we ourselves just issued in this same call — rollover always looks
// at the period *before* `period`, never at `period` itself.
export async function onRenewalPaid(input: OnRenewalPaidInput): Promise<OnRenewalPaidResult> {
  const { sub, payment, policy, ledger, repo, clock } = input;

  const period = payment.period ?? sub.currentPeriod;
  const periodKey = `grant:${sub.id}:${period.start.toISOString()}`;

  // SB-10 — a late successful native-provider payment after final cancellation/expiry is handled by
  // the webhook's needs-human path; the lifecycle primitive must not grant or revive it directly.
  if (payment.status === 'succeeded' && (sub.provider === 'stripe' || sub.provider === 'polar') &&
      (sub.status === 'canceled' || sub.status === 'expired')) {
    throw new PaymentKitError('terminal native subscription payment requires human review', 'subscription_terminal_payment', {
      subscriptionId: sub.id, paymentId: payment.id, status: sub.status,
    });
  }

  const anchorUpgrade = await settleUpgradeAnchorInvoice(input);
  if (anchorUpgrade) return anchorUpgrade;

  // EC:A7 — same-period re-activation (or a re-delivered webhook for a period already granted)
  // must not regrant.
  const existing = (await ledger.entries(sub.customerId, { kind: 'grant', source: 'subscription' })).find(
    (e) => keyMatchesInstant(e.idempotencyKey, `grant:${sub.id}:`, period.start),
  );
  if (existing) {
    // A grant can commit before the subscription write fails. Finish that write on retry,
    // without regranting, rolling back a newer period, or reviving a canceled subscription.
    const needsAdvance = period.end > sub.currentPeriod.end &&
      (sub.status === 'active' || sub.status === 'past_due');
    const paidPlan = needsAdvance ? await resolvePaidPlan({ sub, payment, policy, repo, clock }) : null;
    const updated = needsAdvance && paidPlan ? { ...sub, planId: paidPlan.id,
      scheduledPlanId: null,
      currentPeriod: period, status: 'active' as const, graceUntil: null } : sub;
    if (needsAdvance) await repo.subscriptions.put(updated);
    await grantPendingUpgrade({ sub, payment, period, existingPaymentId: existing.reference.paymentId ?? null, ledger, repo, clock }); // EC:A77
    return {
      sub: updated,
      grant: { entry: existing, duplicated: true, deferred: false, offset: 0, offsetEntries: [] },
      rollover: NO_ROLLOVER,
      duplicated: true,
      recovered: needsAdvance && sub.status === 'past_due',
    };
  }

  // EC:A25 — only money that actually arrived buys a period. A pending/draft invoice (or any other
  // non-succeeded status) is refused before any write; the webhook record fails and its retry
  // re-fetches the payment, so the grant happens once the provider reports it succeeded.
  if (payment.status !== 'succeeded') {
    throw new PaymentKitError('Renewal payment has not succeeded', 'renewal_payment_not_succeeded', {
      subscriptionId: sub.id, paymentId: payment.id, status: payment.status,
    });
  }

  // EC:A66 — a banned customer's renewal payment buys nothing (the ban ended the subscription): the
  // record fails, so the payment stays in front of a person, who refunds it.
  const owner = await repo.customers.get(sub.customerId);
  if (owner?.status === 'banned') {
    throw new PaymentKitError('customer is banned; this renewal payment is not granted', 'customer_banned', { subscriptionId: sub.id, paymentId: payment.id });
  }

  const wasRecovering = sub.status === 'past_due';

  const paidPlan = await resolvePaidPlan({ sub, payment, policy, repo, clock });
  const plan = paidPlan;

  // EC:B2 — roll over the *previous* period's leftover into `period` before granting `period`'s
  // own fresh credits, so this call never rolls over the grant it is about to issue.
  const rollover = await rolloverOnRenewal({ sub, policy, ledger, clock, newPeriod: period });

  // EC:A15 — payment already succeeded (that's why we're here); force 'active' so grantForPeriod
  // doesn't defer for a stale past_due status.
  const grant = await grantForPeriod({
    sub: { ...sub, planId: plan.id, status: 'active' },
    plan,
    period,
    payment,
    policy,
    ledger,
    clock,
  });

  // EC:A32 — a late payment for a subscription the provider already canceled/expired buys the
  // period it paid for (granted above) but never brings the subscription back to active.
  if (sub.status === 'canceled' || sub.status === 'expired') {
    return { sub, grant, rollover, duplicated: false, recovered: false };
  }
  const updated: Subscription = {
    ...sub,
    planId: plan.id,
    scheduledPlanId: null,
    currentPeriod: period,
    status: 'active',
    graceUntil: null,
  };
  await repo.subscriptions.put(updated);

  return { sub: updated, grant, rollover, duplicated: false, recovered: wasRecovering };
}

/**
 * EC:A77 — a paid provider order for a period already granted, other than the one that paid for it (a
 * Polar plan-change order), releases the upgrade delta the upgrade left waiting for it. A redelivery of
 * the period's own payment never does.
 */
async function grantPendingUpgrade(input: { sub: Subscription; payment: Payment; period: { start: Date; end: Date }; existingPaymentId: string | null; ledger: LedgerStore; repo: Repo; clock: Clock }): Promise<void> {
  const { sub, payment, period, ledger, repo, clock } = input;
  if (payment.status !== 'succeeded' || payment.id === input.existingPaymentId) return;
  const key = pendingUpgradeGrantKey(sub.id, period.start);
  const op = await repo.operations.get(key);
  if (!op || op.status !== 'in_progress') return;
  const pending = op.result as { amount: number; expiresAt: string | null; reason: string };
  await ledger.append({
    customerId: sub.customerId, pool: 'paid', kind: 'grant', amount: pending.amount, unitPriceMinor: null, currency: null,
    expiresAt: pending.expiresAt ? new Date(pending.expiresAt) : null, source: 'subscription',
    reference: { subscriptionId: sub.id, periodStart: period.start, paymentId: payment.id },
    idempotencyKey: `grant:${key}:${pending.reason}`, actor: 'system', reason: pending.reason, // EC:A84 — per waiting upgrade, not the row's plan at webhook time
  });
  await repo.operations.put({ ...op, status: 'done', completedAt: clock.now() });
}
