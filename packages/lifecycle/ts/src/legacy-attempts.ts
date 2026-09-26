// spec: packages/lifecycle/spec/lifecycle.pseudo.md — EC:A38 A39
// Attempts the scheduler and dunning no longer re-drive, settled by asking the provider (never by
// charging again):
//   EC:A38 — an attempt left pending when its subscription expired or was canceled;
//   EC:A39 — a dunning charge an earlier release (before EC:A34) made without a payment row, whose
//            subscription therefore still looks unpaid for that period.
import { Clock, NoopNotifier, Notifier, Payment, PaymentProvider, Period, Policy, Repo, LedgerStore, Subscription } from 'boilpayment-core';
import { attemptKeyOf, attemptPaymentId, settleAttemptByLookup } from './charge-attempt.js';
import { onRenewalPaid } from './renewal.js';

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
  provider: PaymentProvider; repo: Repo; clock: Clock; sub: Subscription; period: Period;
}): Promise<LegacyCheck> {
  const { provider, repo, clock, sub, period } = input;
  const items = (await repo.outbox.list()).filter((i) =>
    i.id.startsWith(`${RETRY_ITEM_PREFIX}${sub.id}:`) && i.status === 'sent' &&
    i.createdAt.getTime() >= sub.currentPeriod.end.getTime());
  if (!items.length) return { kind: 'none' };
  const unverified: string[] = [];
  for (const item of items) {
    const attempt = Number((item.payload as { attempt?: unknown }).attempt);
    if (!Number.isInteger(attempt)) continue;
    const key = legacyDunningKey(sub.id, attempt);
    const id = attemptPaymentId(key);
    let row = await repo.payments.get(id);
    if (!row) {
      row = {
        id, customerId: sub.customerId, provider: sub.provider, providerRef: key, subscriptionId: sub.id,
        amount: { amountMinor: 0, currency: sub.currency ?? 'KRW' }, status: 'pending', kind: 'subscription', period,
        occurredAt: item.createdAt, failure: null, cashReceipt: null,
        raw: { boilpaymentAttemptKey: key, boilpaymentLegacyOrderId: key },
      };
      await repo.payments.put(row);
    }
    const settled = row.status === 'pending' ? await settleAttemptByLookup({ provider, repo, clock, row }) : row;
    if (!settled) { unverified.push(key); continue; }
    if (settled.status === 'succeeded') return { kind: 'paid', payment: settled };
  }
  return unverified.length ? { kind: 'unverified', orderIds: unverified } : { kind: 'none' };
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
    if (sub && (sub.status === 'active' || sub.status === 'past_due')) continue; // the scheduler/dunning re-drive these
    const done = await settleAttemptByLookup({ provider, repo, clock, row });
    if (!done) { unresolved.push({ subscriptionId: row.subscriptionId as string, paymentId: row.id, status: 'pending' }); continue; }
    settled.push({ subscriptionId: row.subscriptionId as string, paymentId: row.id, status: done.status });
    if (done.status === 'succeeded' && sub) {
      await onRenewalPaid({ sub, payment: done, policy, ledger, repo, clock });
      await notifier.send({ type: 'cs.needs_human', customerId: sub.customerId, payload: {
        kind: 'renewal_settled_after_end', subscriptionId: sub.id, paymentId: done.id, status: sub.status } });
    }
  }
  return { settled, unresolved };
}

