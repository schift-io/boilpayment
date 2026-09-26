// spec: packages/lifecycle/spec/lifecycle.pseudo.md — EC:A7 A15 A17 B12
import { Clock, LedgerStore, PaymentKitError, Payment, Policy, Repo, Subscription } from '@schift/payment-kit-core';
import { grantForPeriod, GrantResult, rolloverOnRenewal, RolloverResult } from '@schift/payment-kit-credits';

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

  // EC:A7 — same-period re-activation (or a re-delivered webhook for a period already granted)
  // must not regrant.
  const existing = (await ledger.entries(sub.customerId, { kind: 'grant', source: 'subscription' })).find(
    (e) => e.idempotencyKey === periodKey,
  );
  if (existing) {
    // A grant can commit before the subscription write fails. Finish that write on retry,
    // without regranting, rolling back a newer period, or reviving a canceled subscription.
    const needsAdvance = period.end > sub.currentPeriod.end &&
      (sub.status === 'active' || sub.status === 'past_due');
    const updated = needsAdvance ? { ...sub, planId: sub.scheduledPlanId ?? sub.planId,
      scheduledPlanId: null, currentPeriod: period, status: 'active' as const, graceUntil: null } : sub;
    if (needsAdvance) await repo.subscriptions.put(updated);
    return {
      sub: updated,
      grant: { entry: existing, duplicated: true, deferred: false, offset: 0, offsetEntries: [] },
      rollover: NO_ROLLOVER,
      duplicated: true,
      recovered: needsAdvance && sub.status === 'past_due',
    };
  }

  const wasRecovering = sub.status === 'past_due';

  const plan = await repo.plans.get(sub.scheduledPlanId ?? sub.planId);
  if (!plan) throw new PaymentKitError(`plan not found: ${sub.scheduledPlanId ?? sub.planId}`, 'plan_not_found');

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
