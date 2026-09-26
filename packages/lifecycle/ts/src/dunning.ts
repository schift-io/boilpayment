// spec: packages/lifecycle/spec/lifecycle.pseudo.md — EC:A13 A16 A17 A24
import {
  Clock,
  IdGen,
  LedgerEntry,
  LedgerStore,
  Notifier,
  OutboxItem,
  PaymentKitError,
  Payment,
  PaymentProvider,
  Policy,
  Repo,
  Subscription,
} from 'boilpayment-core';
import { grantForPeriod, GrantResult } from 'boilpayment-credits';
import { retryOnVersionConflict } from './retry.js';
import { priceForSubscription, renewalPlanId } from './internal.js';
import { attemptKeyOf, attemptsFor, chargeAttempt, dunningAttemptKey } from './charge-attempt.js';
import { nextPeriod } from './period.js';
import { onRenewalPaid } from './renewal.js';

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;

// EC:A24 — outbox item kind used to schedule a smart-retry charge attempt inside the grace
// window. See retryDue()/runRetry() below.
const RETRY_KIND = 'dunning.retry';

// EC:A24 — hours to wait before attempt N (1-based) of policy.dunning.retryIntervalHours; a
// shorter list than retryAttempts repeats its last value for the remaining attempts.
function retryGapHours(attemptNumber: number, intervals: number[]): number {
  if (intervals.length === 0) return 0;
  const idx = Math.min(attemptNumber - 1, intervals.length - 1);
  return intervals[idx];
}

// Deterministic id — a redelivered failure webhook re-schedules the SAME attempt-1 item instead
// of piling up duplicates (repo.outbox.put is keyed by id, see MemTable.put).
function retryOutboxId(subId: string, attempt: number): string {
  return `dunning-retry-item:${subId}:${attempt}`;
}

async function scheduleRetry(repo: Repo, subId: string, attempt: number, from: Date, intervals: number[]): Promise<OutboxItem> {
  const dueAt = new Date(from.getTime() + retryGapHours(attempt, intervals) * HOUR_MS);
  const item: OutboxItem = {
    id: retryOutboxId(subId, attempt),
    kind: RETRY_KIND,
    payload: { subscriptionId: subId, attempt, dueAt: dueAt.toISOString() },
    status: 'pending',
    attempts: 0,
    nextAttemptAt: dueAt,
    createdAt: from,
  };
  return repo.outbox.put(item);
}

export interface OnPaymentFailedInput {
  sub: Subscription;
  policy: Policy;
  repo: Repo;
  notifier: Notifier;
  clock: Clock;
}
export interface OnPaymentFailedResult {
  sub: Subscription;
}

// EC:A13 — start grace period.
export async function onPaymentFailed(input: OnPaymentFailedInput): Promise<OnPaymentFailedResult> {
  const { sub, policy, repo, notifier, clock } = input;
  // EC:A27 — an incomplete subscription never paid: a failed first payment has no access to keep,
  // so no grace period, retries or notices.
  if (sub.status === 'incomplete') return { sub };
  const now = clock.now();
  const graceDays = policy.dunning.graceDays;
  const graceUntil = graceDays > 0 ? new Date(now.getTime() + graceDays * DAY_MS) : now;

  const updated: Subscription = { ...sub, status: 'past_due', graceUntil };
  await repo.subscriptions.put(updated);

  await notifier.send({
    type: 'payment.failed',
    customerId: sub.customerId,
    payload: { subscriptionId: sub.id, graceUntil: graceUntil.toISOString() },
  });
  if (graceDays > 0) {
    await notifier.send({
      type: 'grace.started',
      customerId: sub.customerId,
      payload: { subscriptionId: sub.id, graceUntil: graceUntil.toISOString() },
    });
  }

  // EC:A24 — schedule the first smart-retry attempt inside the grace window. retryAttempts=0
  // (not the default) means "only the provider's own dunning", so nothing is scheduled.
  if (policy.dunning.retryAttempts > 0) {
    await scheduleRetry(repo, sub.id, 1, now, policy.dunning.retryIntervalHours);
  }

  return { sub: updated };
}

export interface OnGraceExpiredInput {
  sub: Subscription;
  policy: Policy;
  ledger: LedgerStore;
  repo: Repo;
  notifier: Notifier;
  clock: Clock;
}
export interface OnGraceExpiredResult {
  sub: Subscription;
  revoked: LedgerEntry[];
}

// EC:A16 — grace period ended without payment; resolve outstanding credits per policy.
export async function onGraceExpired(input: OnGraceExpiredInput): Promise<OnGraceExpiredResult> {
  const { sub, policy, ledger, repo, notifier, clock } = input;
  const now = clock.now();
  const revoked: LedgerEntry[] = [];

  if (policy.dunning.onFinalFailure === 'revoke_unpaid_period') {
    const periodKey = `grant:${sub.id}:${sub.currentPeriod.start.toISOString()}`;
    const all = await ledger.entries(sub.customerId);
    const grant = all.find((e) => e.kind === 'grant' && e.idempotencyKey === periodKey);
    if (grant) {
      const used = all
        .filter((e) => (e.kind === 'consume' || e.kind === 'revoke') && e.reference.grantId === grant.id)
        .reduce((sum, e) => sum + e.amount, 0);
      const remaining = Math.max(0, grant.amount + used);
      if (remaining > 0) {
        const { entry } = await ledger.append({
          customerId: sub.customerId,
          pool: 'paid',
          kind: 'revoke',
          amount: -remaining,
          unitPriceMinor: null,
          currency: null,
          expiresAt: null,
          source: 'subscription',
          reference: { subscriptionId: sub.id, periodStart: sub.currentPeriod.start, grantId: grant.id },
          idempotencyKey: `revoke:dunning:${sub.id}:${sub.currentPeriod.start.toISOString()}`,
          actor: 'system',
          reason: 'grace_expired_unpaid',
        });
        revoked.push(entry);
      }
    }
  } else if (policy.dunning.onFinalFailure === 'revoke_all') {
    const balance = await ledger.balance(sub.customerId, 'paid', now);
    if (balance.available > 0) {
      const { entry } = await ledger.append({
        customerId: sub.customerId,
        pool: 'paid',
        kind: 'revoke',
        amount: -balance.available,
        unitPriceMinor: null,
        currency: null,
        expiresAt: null,
        source: 'subscription',
        reference: { subscriptionId: sub.id },
        idempotencyKey: `revoke:dunning-all:${sub.id}:${sub.currentPeriod.start.toISOString()}`,
        actor: 'system',
        reason: 'grace_expired_unpaid_all',
      });
      revoked.push(entry);
    }
  }
  // 'keep' — no-op

  const updated: Subscription = { ...sub, status: 'expired', graceUntil: null };
  await repo.subscriptions.put(updated);
  await notifier.send({ type: 'grace.ending', customerId: sub.customerId, payload: { subscriptionId: sub.id } });

  return { sub: updated, revoked };
}

export interface OnRecoveredInput {
  sub: Subscription;
  payment: Payment;
  policy: Policy;
  ledger: LedgerStore;
  repo: Repo;
  clock: Clock;
}
export interface OnRecoveredResult {
  sub: Subscription;
  grants: GrantResult[];
}

// EC:A17 — payment recovered after grace/final-failure.
export async function onRecovered(input: OnRecoveredInput): Promise<OnRecoveredResult> {
  const { sub, payment, policy, ledger, repo, clock } = input;
  const grants: GrantResult[] = [];

  if (policy.dunning.onRecovery === 'no_regrant') {
    const updated: Subscription = { ...sub, status: 'active', graceUntil: null };
    await repo.subscriptions.put(updated);
    return { sub: updated, grants };
  }

  // EC:A29 — recovery completes the renewal into the plan it was renewing to (a scheduled change).
  const plan = await repo.plans.get(renewalPlanId(sub));
  if (!plan) throw new PaymentKitError(`plan not found: ${renewalPlanId(sub)}`, 'plan_not_found');

  // 'regrant_current_period' and 'regrant_all_missed' both regrant the current period here;
  // multi-period backfill needs a paid-period history the Repo doesn't track yet (see spec note #3).
  const g = await grantForPeriod({ sub: { ...sub, planId: plan.id, status: 'active' }, plan, period: sub.currentPeriod, payment, policy, ledger, clock });
  grants.push(g);

  const updated: Subscription = { ...sub, planId: plan.id, scheduledPlanId: null, status: 'active', graceUntil: null };
  await repo.subscriptions.put(updated);

  return { sub: updated, grants };
}

// ── EC:A24 smart retry ──────────────────────────────────────────────────────────────────────

export interface RetryDueInput {
  repo: Repo;
  clock: Clock;
  limit?: number;
}

// EC:A24 — 'dunning.retry' outbox items whose scheduled attempt time has arrived.
export async function retryDue(input: RetryDueInput): Promise<OutboxItem[]> {
  const { repo, clock, limit } = input;
  const now = clock.now();
  const pending = await repo.outbox.list({ kind: RETRY_KIND, status: 'pending' } as Partial<OutboxItem>);
  const due = pending.filter((item) => item.nextAttemptAt <= now).sort((a, b) => a.nextAttemptAt.getTime() - b.nextAttemptAt.getTime());
  return limit !== undefined ? due.slice(0, limit) : due;
}

export interface RunRetryInput {
  item: OutboxItem;
  provider: PaymentProvider;
  repo: Repo;
  ledger: LedgerStore;
  policy: Policy;
  notifier: Notifier;
  clock: Clock;
  /** Reserved for future use — retry bookkeeping uses deterministic outbox ids, not ids.newId(). */
  ids?: IdGen;
}

export type RunRetryOutcome = 'recovered' | 'failed' | 'unresolved' | 'skipped' | 'deferred_to_provider';
export interface RunRetryResult {
  outcome: RunRetryOutcome;
  sub: Subscription | null;
  grants: GrantResult[];
}

// EC:A24 — execute one scheduled dunning-retry attempt.
export async function runRetry(input: RunRetryInput): Promise<RunRetryResult> {
  const { item, provider, repo, ledger, policy, notifier, clock } = input;
  const payload = item.payload as { subscriptionId: string; attempt: number };

  return retryOnVersionConflict(async () => {
    // EC:K1 — re-read on every attempt; another writer (webhook, scheduler tick, a manual
    // cancel) may have touched this row since the item was scheduled.
    const sub = await repo.subscriptions.get(payload.subscriptionId);
    if (!sub || sub.status !== 'past_due') {
      // Already recovered (e.g. the provider's own dunning succeeded first via webhook),
      // canceled, or expired — this scheduled attempt no longer applies.
      item.status = 'sent';
      item.attempts += 1;
      await repo.outbox.put(item);
      return { outcome: 'skipped' as const, sub: sub ?? null, grants: [] };
    }

    const canCharge = provider.capabilities().scheduling === 'self' && sub.billingKey !== null;
    if (!canCharge) {
      // Provider-scheduled dunning (Stripe/Polar/PortOne's own schedule) drives the actual
      // charge and reports its outcome via webhook (onPaymentSucceeded/onPaymentFailed). We
      // only advance our own attempt counter here so grace.ending still fires on schedule if
      // the provider's own retries never recover it.
      item.status = 'sent';
      item.attempts += 1;
      await repo.outbox.put(item);
      if (payload.attempt < policy.dunning.retryAttempts) {
        await scheduleRetry(repo, sub.id, payload.attempt + 1, clock.now(), policy.dunning.retryIntervalHours);
      }
      return { outcome: 'deferred_to_provider' as const, sub, grants: [] };
    }

    const plan = await repo.plans.get(renewalPlanId(sub)); // EC:A29
    const price = plan ? priceForSubscription(plan, sub) : null; // EC:A28
    if (!plan || !price) {
      // EC:A31 — a configuration fault, not a decline: tell a person and keep the retry schedule so a
      // fixed plan price is charged on the next attempt.
      item.status = 'sent';
      item.attempts += 1;
      await repo.outbox.put(item);
      await notifier.send({ type: 'cs.needs_human', customerId: sub.customerId, payload: {
        kind: 'plan_price_missing', subscriptionId: sub.id, planId: renewalPlanId(sub), currency: sub.currency ?? null } });
      if (payload.attempt < policy.dunning.retryAttempts) {
        await scheduleRetry(repo, sub.id, payload.attempt + 1, clock.now(), policy.dunning.retryIntervalHours);
      }
      return { outcome: 'failed' as const, sub, grants: [] };
    }

    // EC:A34 — the retry pays for the renewal that failed: the period after the current one. The
    // attempt is a recorded payment like the scheduler's; a succeeded attempt (any, this one or an
    // earlier one whose local steps failed) completes the renewal through onRenewalPaid, which grants
    // THAT period (usable, not already expired) and advances the subscription — so the next tick has
    // nothing left to charge for it (EC:A34 N1).
    const chargedPeriod = nextPeriod(sub.currentPeriod, plan.interval ?? 'month', sub.anchorDay, policy.period.timezone, policy.period.monthEndAnchor);
    const attempts = await attemptsFor(repo, sub, chargedPeriod);
    const earlier = attempts.find((p) => p.status === 'succeeded');
    const open = attempts.find((p) => p.status !== 'failed' && p.status !== 'succeeded');
    const attemptKey = (open && attemptKeyOf(open)) || dunningAttemptKey(sub, chargedPeriod, payload.attempt);
    const charge = earlier
      ? { kind: 'succeeded' as const, payment: earlier }
      : await chargeAttempt({ provider, repo, clock, sub, price, period: chargedPeriod, attemptKey });
    item.attempts += 1;

    if (charge.kind === 'succeeded') {
      item.status = 'sent';
      await repo.outbox.put(item);
      const result = await onRenewalPaid({ sub, payment: charge.payment, policy, ledger, repo, clock });
      return { outcome: 'recovered' as const, sub: result.sub, grants: [result.grant] };
    }

    if (charge.kind === 'unresolved') {
      // EC:A34 A36 (N11) — no answer is not a decline: the same attempt is re-driven later with the
      // same key (never a new charge while this one may have moved money). A person is told once.
      item.nextAttemptAt = new Date(clock.now().getTime() + Math.max(1, retryGapHours(payload.attempt, policy.dunning.retryIntervalHours)) * HOUR_MS);
      await repo.outbox.put(item);
      if (charge.first) {
        await notifier.send({ type: 'cs.needs_human', customerId: sub.customerId, payload: {
          kind: 'renewal_charge_unresolved', subscriptionId: sub.id, paymentId: charge.payment.id, reason: charge.reason } });
      }
      return { outcome: 'unresolved' as const, sub, grants: [] };
    }

    item.status = 'sent';
    await repo.outbox.put(item);
    await notifier.send({
      type: 'payment.failed',
      customerId: sub.customerId,
      payload: { subscriptionId: sub.id, attempt: payload.attempt },
    });

    if (payload.attempt < policy.dunning.retryAttempts) {
      await scheduleRetry(repo, sub.id, payload.attempt + 1, clock.now(), policy.dunning.retryIntervalHours);
    } else {
      // Retries exhausted — the existing graceUntil-driven onGraceExpired path finishes it.
      await notifier.send({ type: 'grace.ending', customerId: sub.customerId, payload: { subscriptionId: sub.id } });
    }

    return { outcome: 'failed' as const, sub, grants: [] };
  });
}
