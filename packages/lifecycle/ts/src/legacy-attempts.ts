// spec: packages/lifecycle/spec/lifecycle.pseudo.md — EC:A38 A39
// Attempts the scheduler and dunning no longer re-drive, settled by asking the provider (never by
// charging again):
//   EC:A38 — an attempt left pending when its subscription expired or was canceled;
//   EC:A39 — a dunning charge an earlier release (before EC:A34) made without a payment row, whose
//            subscription therefore still looks unpaid for that period.
import { Clock, Money, NoopNotifier, Notifier, Payment, PaymentProvider, Period, Policy, Repo, LedgerStore, Subscription } from 'boilpayment-core';
import { attemptKeyOf, attemptPaymentId, dunningAttemptKey, isUnderReview, settleAttemptByLookup } from './charge-attempt.js';
import { onRenewalPaid } from './renewal.js';
import { nextPeriod } from './period.js';
import { priceForSubscription } from './internal.js';

const RETRY_ITEM_PREFIX = 'dunning-retry-item:';

/** The key and orderId a pre-A34 release used for dunning retry n (no period in it). */
export function legacyDunningKey(subId: string, attempt: number): string {
  return `dunning-retry:${subId}:${attempt}`;
}

export type LegacyCheck =
  | { kind: 'none' }
  | { kind: 'paid'; payment: Payment }
  /** A legacy charge may have moved money and the provider cannot tell us yet: do not charge. */
  | { kind: 'unverified'; orderIds: string[] };

/**
 * EC:A39 — before a NEW charge for `period`, find dunning retries of the subscription that were sent
 * after its current period ended and left no attempt row (a pre-A34 release charged them with orderId
 * `dunning-retry:<sub>:<n>`). Each is looked up at the provider: a succeeded one becomes the attempt
 * row for `period` and pays it; an unknown order is closed; an unanswerable lookup blocks the charge.
 */
export async function checkLegacyDunning(input: {
  provider: PaymentProvider; repo: Repo; clock: Clock; sub: Subscription; period: Period; price?: Money | null; notifier?: Notifier;
}): Promise<LegacyCheck> {
  const { provider, repo, clock, sub, period } = input;
  const items = (await repo.outbox.list()).filter((i) =>
    i.id.startsWith(`${RETRY_ITEM_PREFIX}${sub.id}:`) && i.status === 'sent' &&
    i.createdAt.getTime() >= sub.currentPeriod.end.getTime());
  if (!items.length) return { kind: 'none' };
  const unverified: string[] = [];
  let paid: Payment | null = null;
  // EC:A55 — every key is looked up, not only the first that paid: an earlier release that lost an
  // answer retried and may have charged twice. The first success pays the period; any later one is a
  // second charge for the same period and a person is told (once: only when its row settles here).
  for (const item of items) {
    const attempt = Number((item.payload as { attempt?: unknown }).attempt);
    if (!Number.isInteger(attempt)) continue;
    // A retry this release ran left its own attempt row (period in the key): not a legacy charge.
    if (await repo.payments.get(attemptPaymentId(dunningAttemptKey(sub, period, attempt)))) continue;
    const key = legacyDunningKey(sub.id, attempt);
    const id = attemptPaymentId(key);
    let row = await repo.payments.get(id);
    if (!row) {
      row = {
        id, customerId: sub.customerId, provider: sub.provider, providerRef: key, subscriptionId: sub.id,
        // EC:A50 — the price the earlier release charged is the plan price; a lookup must match it.
        amount: input.price ? { ...input.price } : { amountMinor: 0, currency: sub.currency ?? 'KRW' }, status: 'pending', kind: 'subscription', period,
        occurredAt: item.createdAt, failure: null, cashReceipt: null,
        raw: { boilpaymentAttemptKey: key, boilpaymentLegacyOrderId: key },
      };
      await repo.payments.put(row);
    }
    const wasPending = row.status === 'pending';
    const settled = wasPending
      ? await settleAttemptByLookup({ provider, repo, clock, row, expected: input.price ?? null, notifier: input.notifier })
      : row;
    if (!settled) { unverified.push(key); continue; }
    if (settled.status !== 'succeeded') continue;
    if (!paid) { paid = settled; continue; }
    if (wasPending) await notifyDoubleCharge(input.notifier, sub, settled.id, paid.id);
  }
  if (paid) return { kind: 'paid', payment: paid };
  return unverified.length ? { kind: 'unverified', orderIds: unverified } : { kind: 'none' };
}

/** EC:A55 — a second payment that moved money for a period another payment already bought. */
export async function notifyDoubleCharge(notifier: Notifier | undefined, sub: Subscription, paymentId: string, firstPaymentId: string | null): Promise<void> {
  await notifier?.send({ type: 'cs.needs_human', customerId: sub.customerId, payload: {
    kind: 'renewal_double_charge', subscriptionId: sub.id, paymentId, firstPaymentId } });
}

/**
 * EC:A39 (A5-3) — a subscription that ended (expired/canceled) while an earlier release's dunning
 * charge had moved money it recorded as failed. Nobody renews it any more, so the charge is found here
 * by lookup: a paid one gets its row and buys the period it paid for (EC:A32: the subscription stays
 * ended), and a person is told once. Each legacy key is looked up until it is settled, then never again.
 */
export async function settleLegacyEnded(input: {
  provider: PaymentProvider; repo: Repo; ledger: LedgerStore; policy: Policy; clock: Clock; notifier: Notifier;
}): Promise<LateSettlement[]> {
  const { provider, repo, ledger, policy, clock, notifier } = input;
  const out: LateSettlement[] = [];
  const items = (await repo.outbox.list()).filter((i) => i.id.startsWith(RETRY_ITEM_PREFIX) && i.status === 'sent');
  const bySub = new Map<string, number[]>();
  for (const i of items) {
    const p = i.payload as { subscriptionId?: unknown; subscription_id?: unknown; attempt?: unknown };
    const subId = String(p.subscriptionId ?? p.subscription_id ?? '');
    const attempt = Number(p.attempt);
    if (!subId || !Number.isInteger(attempt)) continue;
    bySub.set(subId, [...(bySub.get(subId) ?? []), attempt]);
  }
  for (const [subId] of bySub) {
    const sub = await repo.subscriptions.get(subId);
    if (!sub || sub.provider !== provider.name || (sub.status !== 'expired' && sub.status !== 'canceled')) continue;
    const plan = await repo.plans.get(sub.scheduledPlanId ?? sub.planId);
    if (!plan) continue;
    const period = nextPeriod(sub.currentPeriod, plan.interval ?? 'month', sub.anchorDay, policy.period.timezone, policy.period.monthEndAnchor);
    const price = priceForSubscription(plan, sub);
    const pendingOnly = { ...sub };
    // only keys not settled yet: a settled legacy row (succeeded or failed) is final
    const legacy = await checkLegacyDunningUnsettled({ provider, repo, clock, sub: pendingOnly, period, price, notifier });
    if (legacy.kind === 'paid') {
      const result = await onRenewalPaid({ sub, payment: legacy.payment, policy, ledger, repo, clock });
      // A6-5 — a key settled on an earlier tick is found again while another key is still open: its
      // period is already granted (duplicated), so the person was already told.
      if (result.duplicated) continue;
      await notifier.send({ type: 'cs.needs_human', customerId: sub.customerId, payload: {
        kind: 'renewal_settled_after_end', subscriptionId: sub.id, paymentId: legacy.payment.id, status: sub.status } });
      out.push({ subscriptionId: sub.id, paymentId: legacy.payment.id, status: 'succeeded' });
    }
  }
  return out;
}

/** checkLegacyDunning restricted to keys whose row is absent or still pending (settled ones are final). */
async function checkLegacyDunningUnsettled(input: Parameters<typeof checkLegacyDunning>[0]): Promise<LegacyCheck> {
  const { repo, sub } = input;
  const items = (await repo.outbox.list()).filter((i) => i.id.startsWith(`${RETRY_ITEM_PREFIX}${sub.id}:`) && i.status === 'sent');
  for (const item of items) {
    const attempt = Number((item.payload as { attempt?: unknown }).attempt);
    const row = Number.isInteger(attempt) ? await repo.payments.get(attemptPaymentId(legacyDunningKey(sub.id, attempt))) : null;
    if (!row || (row.status === 'pending' && !isUnderReview(row))) return checkLegacyDunning(input);
  }
  return { kind: 'none' };
}

export interface LateSettlement { subscriptionId: string; paymentId: string; status: string }

/**
 * EC:A38 — attempt rows still pending whose subscription is no longer renewed (expired/canceled, or
 * gone): ask the provider. A charge that turned out to have succeeded is recorded and buys the period
 * it paid for (usable credits; the subscription stays ended, EC:A32), and a person is told once.
 */
export async function settleOrphanAttempts(input: {
  provider: PaymentProvider; repo: Repo; ledger: LedgerStore; policy: Policy; clock: Clock; notifier?: Notifier;
}): Promise<{ settled: LateSettlement[]; unresolved: LateSettlement[] }> {
  const { provider, repo, ledger, policy, clock } = input;
  const notifier = input.notifier ?? new NoopNotifier();
  const settled: LateSettlement[] = [];
  const unresolved: LateSettlement[] = [];
  const rows = (await repo.payments.list({ status: 'pending' } as Partial<Payment>)).filter((p) =>
    p.provider === provider.name && p.kind === 'subscription' && p.subscriptionId && attemptKeyOf(p) !== null);
  for (const row of rows) {
    const sub = await repo.subscriptions.get(row.subscriptionId as string);
    const renewing = sub && (sub.status === 'active' || sub.status === 'past_due');
    // EC:A38 (A5-8) — a renewing subscription's attempts are re-driven by the scheduler/dunning, except
    // one for a period the subscription already entered or passed — the scheduler and dunning only charge
    // the period after the current one, so nothing else would ever settle it (an earlier build left it pending).
    const behind = renewing && row.period && row.period.start.getTime() <= (sub as Subscription).currentPeriod.start.getTime();
    if (renewing && !behind) continue;
    const done = await settleAttemptByLookup({ provider, repo, clock, row, notifier });
    if (!done) { unresolved.push({ subscriptionId: row.subscriptionId as string, paymentId: row.id, status: 'pending' }); continue; }
    settled.push({ subscriptionId: row.subscriptionId as string, paymentId: row.id, status: done.status });
    if (done.status === 'succeeded' && sub) {
      const result = await onRenewalPaid({ sub, payment: done, policy, ledger, repo, clock });
      // EC:A55 — the period was already bought by another payment: this one is a second charge.
      const other = result.duplicated ? result.grant.entry?.reference.paymentId ?? null : null;
      if (other && other !== done.id) {
        await notifyDoubleCharge(notifier, sub, done.id, other);
        continue;
      }
      if (!renewing || !result.duplicated) {
        await notifier.send({ type: 'cs.needs_human', customerId: sub.customerId, payload: {
          kind: 'renewal_settled_after_end', subscriptionId: sub.id, paymentId: done.id, status: sub.status } });
      }
    }
  }
  return { settled, unresolved };
}

