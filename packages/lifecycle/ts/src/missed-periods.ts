// spec: packages/lifecycle/spec/lifecycle.pseudo.md — EC:A47
// A self-scheduled subscription can fall more than one period behind: the cron stopped for months, or
// an app upgraded from a release that never renewed it (PortOne before EC:A43). Charging the missed
// periods one tick at a time would bill months the customer could not use (their credits expire as
// they are granted). Policy `subscription.missedPeriods` decides instead:
//   skip_and_notify  — charge only the period containing now (once); the missed periods are skipped
//                      with no charge and no grant; one case lists them;
//   needs_human_only — charge nothing; the subscription waits past_due (no grace clock) for a person.
import { Clock, Notifier, Period, Plan, Policy, Repo, Subscription } from 'boilpayment-core';
import { nextPeriod } from './period.js';

export interface CatchUp {
  /** The last missed period; the subscription is moved here so the next period is `target`. */
  previous: Period;
  /** The period containing now. */
  target: Period;
  /** Periods that ended without a charge (never billed, never granted). */
  skipped: Period[];
}

/** Null when the subscription is at most one period behind (the ordinary renewal). */
export function catchUpPeriods(sub: Subscription, plan: Plan, policy: Policy, now: Date): CatchUp | null {
  const step = (p: Period) => nextPeriod(p, plan.interval ?? 'month', sub.anchorDay, policy.period.timezone, policy.period.monthEndAnchor);
  let previous = sub.currentPeriod;
  let target = step(previous);
  if (target.end.getTime() > now.getTime()) return null;
  const skipped: Period[] = [];
  for (let guard = 0; target.end.getTime() <= now.getTime() && guard < 100_000; guard += 1) {
    skipped.push(target);
    previous = target;
    target = step(target);
  }
  return { previous, target, skipped };
}

export type MissedPeriodsOutcome =
  | { kind: 'none' }
  | { kind: 'parked'; sub: Subscription }
  | { kind: 'skipped'; sub: Subscription; target: Period };

export async function applyMissedPeriods(input: {
  sub: Subscription; plan: Plan; policy: Policy; repo: Repo; notifier: Notifier; clock: Clock;
}): Promise<MissedPeriodsOutcome> {
  const { sub, plan, policy, repo, notifier, clock } = input;
  const cu = catchUpPeriods(sub, plan, policy, clock.now());
  if (!cu) return { kind: 'none' };
  const iso = (p: Period) => p.start.toISOString();
  if (policy.subscription.missedPeriods === 'needs_human_only') {
    const parked: Subscription = { ...sub, status: 'past_due', graceUntil: null };
    const saved = await repo.subscriptions.put(parked);
    await notifier.send({ type: 'cs.needs_human', customerId: sub.customerId, payload: {
      kind: 'missed_periods_parked', subscriptionId: sub.id, missed: [...cu.skipped, cu.target].map(iso) } });
    return { kind: 'parked', sub: saved };
  }
  const saved = await repo.subscriptions.put({ ...sub, currentPeriod: cu.previous });
  await notifier.send({ type: 'cs.needs_human', customerId: sub.customerId, payload: {
    kind: 'missed_periods_skipped', subscriptionId: sub.id, skipped: cu.skipped.map(iso), charging: iso(cu.target) } });
  return { kind: 'skipped', sub: saved, target: cu.target };
}
